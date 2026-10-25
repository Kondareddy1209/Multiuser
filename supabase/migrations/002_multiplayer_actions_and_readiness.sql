-- Treasure Plots migration 002
-- Per-room memberships, idempotent create requests, six moves and lobby readiness.
-- Existing room-member RLS is preserved; only row-filtered realtime reads are granted below.
begin;

alter table public.rooms add column create_request_id uuid;
create unique index rooms_host_create_request_uq
  on public.rooms(host_id,create_request_id) where create_request_id is not null;
alter table public.players add column ready boolean not null default false;

-- Anonymous auth uid is a player identity, not a globally unique membership.
alter table public.actions drop constraint if exists actions_player_id_fkey;
alter table public.actions drop constraint if exists actions_target_id_fkey;
alter table public.players drop constraint players_pkey;
alter table public.players add constraint players_pkey primary key(room_id,id);
alter table public.actions add constraint actions_player_room_fkey
  foreign key(room_id,player_id) references public.players(room_id,id) on delete cascade;
alter table public.actions add constraint actions_target_room_fkey
  foreign key(room_id,target_id) references public.players(room_id,id) on delete cascade;
alter table public.actions drop constraint if exists actions_choice_check;
alter table public.actions drop constraint if exists actions_check;
alter table public.actions add constraint actions_choice_check
  check(choice in ('search','steal','trap','guard','dig_deep','explore'));
-- The unnamed target CHECK in 001 is named actions_check; remove that above,
-- and drop this explicit name too in case the migration was prepared earlier.
alter table public.actions drop constraint if exists actions_target_check;
alter table public.actions add constraint actions_target_check
  check((choice='steal' and target_id is not null) or (choice<>'steal' and target_id is null));

-- Stable request key makes a retry after a lost response return the same room.
drop function public.create_room(text);
create function public.create_room(p_name text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; c text;
begin
 if u is null then raise exception 'Sign in required'; end if;
 if p_request_id is null then raise exception 'Create request id required'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 18 then
   raise exception 'Name must be 1–18 characters';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_request_id::text,0));
 select * into r from public.rooms where host_id=u and create_request_id=p_request_id;
 if found then return jsonb_build_object('code',r.code); end if;
 loop
   c:=upper(substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,6));
   exit when not exists(select 1 from public.rooms where code=c);
 end loop;
 insert into public.rooms(code,host_id,create_request_id) values(c,u,p_request_id) returning * into r;
 insert into public.players(id,room_id,name,ready) values(u,r.id,trim(p_name),false)
   on conflict(room_id,id) do update set name=excluded.name,active=true,last_seen=now(),ready=false;
 return jsonb_build_object('code',r.code);
end; $$;

create or replace function public.join_room(p_code text,p_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; p public.players%rowtype;
begin
 if u is null then raise exception 'Sign in required'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 18 then
   raise exception 'Name must be 1–18 characters';
 end if;
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found then raise exception 'Room code not found'; end if;
 select * into p from public.players where room_id=r.id and id=u for update;
 if found then
   if r.status='playing' and p.last_seen<now()-interval '90 seconds'
      and not exists(select 1 from public.actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=u) then
     perform public.resolve_round_internal(r.id,r.round_no);
   end if;
   update public.players set last_seen=now(),active=true where room_id=r.id and id=u;
   return jsonb_build_object('code',r.code);
 end if;
 if r.status<>'lobby' then raise exception 'This game has already started'; end if;
 if (select count(*) from public.players where room_id=r.id and active)>=8 then raise exception 'Room is full'; end if;
 insert into public.players(id,room_id,name,ready) values(u,r.id,trim(p_name),false)
   on conflict(room_id,id) do update set active=true,last_seen=now();
 return jsonb_build_object('code',r.code);
end; $$;

create or replace function public.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from public.rooms where code=upper(trim(p_code));
 if not found then raise exception 'Room code not found'; end if;
 if not exists(select 1 from public.players where id=u and room_id=r.id and active) then raise exception 'Not a room member'; end if;
 return jsonb_build_object(
  'id',r.id,'code',r.code,'host_id',r.host_id,'status',r.status,'round_no',r.round_no,
  'players',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'coins',p.coins,'active',p.active,'ready',p.ready) order by p.joined_at),'[]'::jsonb)
    from public.players p where p.room_id=r.id and p.active),
  'submitted',(select count(*) from public.actions a where a.room_id=r.id and a.round_no=r.round_no),
  'my_action',(select jsonb_build_object('choice',a.choice,'target_id',a.target_id) from public.actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=u),
  'result',(select payload from public.round_results where room_id=r.id and round_no=r.round_no),
  'all_results',(select coalesce(jsonb_agg(payload order by round_no),'[]'::jsonb) from public.round_results where room_id=r.id));
end; $$;

create or replace function public.set_player_ready(p_code text,p_ready boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 if u is null then raise exception 'Sign in required'; end if;
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found or r.status<>'lobby' then raise exception 'Room is not accepting readiness'; end if;
 update public.players set ready=p_ready,last_seen=now() where room_id=r.id and id=u and active;
 if not found then raise exception 'Not an active player'; end if;
 return jsonb_build_object('ok',true,'ready',p_ready);
end; $$;

create or replace function public.start_game(p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found or r.host_id<>u then raise exception 'Only host can start'; end if;
 if r.status<>'lobby' then raise exception 'Game already started'; end if;
 if (select count(*) from public.players where room_id=r.id and active)<2 then raise exception 'At least 2 players needed'; end if;
 if exists(select 1 from public.players where room_id=r.id and active and not ready) then raise exception 'Every active player must confirm readiness'; end if;
 update public.players set last_seen=now() where room_id=r.id and active;
 update public.rooms set status='playing',round_no=1 where id=r.id;
 return jsonb_build_object('ok',true);
end; $$;

-- Room lock makes resolution atomic. Random choices are made on the server from
-- a UUID generated by PostgreSQL, and appear only in the committed round result.
create or replace function public.resolve_round_internal(rid uuid,rn int)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
 r public.rooms%rowtype; a record; t record; protection text;
 n int; share_n int; rem_n int; amt int; rank_n int; success boolean;
 ev jsonb:='[]'::jsonb; cs jsonb; balances jsonb;
begin
 select * into r from public.rooms where id=rid for update;
 if r.status<>'playing' or r.round_no<>rn or exists(select 1 from public.round_results where room_id=rid and round_no=rn) then return; end if;
 select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into balances from public.players where room_id=rid and active;

 -- Apply non-steal action costs and gains before thefts.
 for a in
   select act.*,p.name from public.actions act join public.players p on p.room_id=act.room_id and p.id=act.player_id
   where act.room_id=rid and act.round_no=rn and act.choice<>'steal' order by act.player_id
 loop
   if a.choice='search' then
     update public.players set coins=coins+2 where room_id=rid and id=a.player_id;
     ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','search','delta',2));
   elsif a.choice in ('trap','guard','dig_deep','explore') then
     update public.players set coins=coins-1 where room_id=rid and id=a.player_id and coins>=1;
     if not found then raise exception 'Insufficient coins for locked action'; end if;
     if a.choice in ('trap','guard') then
       ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice',a.choice,'delta',-1));
     elsif a.choice='dig_deep' then
       success:=(pg_catalog.get_byte(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()),0)&128)=0;
       if success then update public.players set coins=coins+4 where room_id=rid and id=a.player_id; end if;
       ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','dig_deep','success',success,'delta',case when success then 3 else -1 end));
     else
       update public.players set coins=coins+1 where room_id=rid and id=a.player_id;
       success:=(pg_catalog.get_byte(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()),0)&128)=0;
       if success then update public.players set coins=coins+2 where room_id=rid and id=a.player_id; end if;
       ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','explore','success',success,'delta',case when success then 2 else 0 end));
     end if;
   end if;
 end loop;

 -- Record hidden targeting decisions; they become visible only with the result.
 for a in
   select act.player_id,p.name,act.target_id,targ.name as target_name
   from public.actions act join public.players p on p.room_id=act.room_id and p.id=act.player_id
   join public.players targ on targ.room_id=act.room_id and targ.id=act.target_id
   where act.room_id=rid and act.round_no=rn and act.choice='steal' order by act.player_id
 loop
   ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','steal','target_id',a.target_id,'target_name',a.target_name,'delta',0));
 end loop;
 select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into balances from public.players where room_id=rid and active;

 -- Resolve all trap penalties before regular steal splits so the two deductions
 -- share one available balance and cannot drive a player below zero.
 for t in
   select distinct act.target_id,p.name
   from public.actions act join public.players p on p.room_id=act.room_id and p.id=act.target_id
   where act.room_id=rid and act.round_no=rn and act.choice='steal'
     and exists(select 1 from public.actions prot where prot.room_id=rid
       and prot.round_no=rn and prot.player_id=act.target_id and prot.choice='trap')
 loop
   update public.players set coins=coins+2 where room_id=rid and id=t.target_id;
   for a in
     select act.player_id,p.name from public.actions act
     join public.players p on p.room_id=act.room_id and p.id=act.player_id
     where act.room_id=rid and act.round_no=rn and act.choice='steal' and act.target_id=t.target_id
     order by md5(act.player_id::text||rn::text)
   loop
     amt:=least(2,coalesce((balances->>a.player_id::text)::int,0));
     if amt>0 then
       update public.players set coins=coins-amt where room_id=rid and id=a.player_id and coins>=amt;
       if not found then raise exception 'Coin invariant failed while resolving trap'; end if;
     end if;
     ev:=ev||jsonb_build_array(jsonb_build_object('type','trap_penalty',
       'thief_id',a.player_id,'thief_name',a.name,'target_id',t.target_id,
       'target_name',t.name,'amount',amt,'delta',-amt));
   end loop;
   ev:=ev||jsonb_build_array(jsonb_build_object('type','trap_blocked',
     'target_id',t.target_id,'target_name',t.name,
     'count',(select count(*) from public.actions where room_id=rid and round_no=rn
       and choice='steal' and target_id=t.target_id),'delta',2));
 end loop;

 -- Re-snapshot after trap penalties. Ordinary thefts use this shared balance.
 select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into balances
   from public.players where room_id=rid and active;
 for t in
   select distinct act.target_id,p.name,(balances->>act.target_id::text)::int as coins
   from public.actions act join public.players p on p.room_id=act.room_id and p.id=act.target_id
   where act.room_id=rid and act.round_no=rn and act.choice='steal'
 loop
   select choice into protection from public.actions
     where room_id=rid and round_no=rn and player_id=t.target_id and choice in ('trap','guard');
   if protection='trap' then
     continue;
   elsif protection='guard' then
     for a in
       select act.player_id,p.name from public.actions act
       join public.players p on p.room_id=act.room_id and p.id=act.player_id
       where act.room_id=rid and act.round_no=rn and act.choice='steal' and act.target_id=t.target_id
     loop
       ev:=ev||jsonb_build_array(jsonb_build_object('type','guard_blocked',
         'thief_id',a.player_id,'thief_name',a.name,'target_id',t.target_id,
         'target_name',t.name,'amount',0,'delta',0));
     end loop;
   else
     select count(*) into n from public.actions
       where room_id=rid and round_no=rn and choice='steal' and target_id=t.target_id;
     share_n:=least(t.coins,2*n)/n; rem_n:=least(t.coins,2*n)%n; rank_n:=0;
     for a in
       select act.player_id,p.name from public.actions act
       join public.players p on p.room_id=act.room_id and p.id=act.player_id
       where act.room_id=rid and act.round_no=rn and act.choice='steal' and act.target_id=t.target_id
       order by md5(act.player_id::text||rn::text)
     loop
       amt:=share_n+case when rank_n<rem_n then 1 else 0 end;
       rank_n:=rank_n+1;
       if amt>0 then
         update public.players set coins=coins+amt where room_id=rid and id=a.player_id;
         update public.players set coins=coins-amt where room_id=rid and id=t.target_id and coins>=amt;
         if not found then raise exception 'Coin invariant failed while resolving steal'; end if;
       end if;
       ev:=ev||jsonb_build_array(jsonb_build_object('type','theft',
         'thief_id',a.player_id,'thief_name',a.name,'target_id',t.target_id,
         'target_name',t.name,'amount',amt,'delta',amt));
     end loop;
   end if;
 end loop; select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into cs from public.players where room_id=rid and active;
 insert into public.round_results(room_id,round_no,payload) values(rid,rn,jsonb_build_object('round',rn,'events',ev,'coins',cs));
 if rn>=3 then update public.rooms set status='finished' where id=rid;
 else update public.rooms set round_no=rn+1 where id=rid; end if;
end; $$;

create or replace function public.heartbeat(p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; missing_n int; timed_out boolean;
begin
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found or not exists(select 1 from public.players where id=u and room_id=r.id and active) then raise exception 'Room membership expired'; end if;
 if r.status='playing' then
   select count(*) into missing_n from public.players p where p.room_id=r.id and p.active
     and not exists(select 1 from public.actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id);
   select exists(select 1 from public.players p where p.room_id=r.id and p.active
     and p.last_seen<now()-interval '90 seconds' and not exists(select 1 from public.actions a
       where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id)) into timed_out;
   if missing_n=0 or timed_out then perform public.resolve_round_internal(r.id,r.round_no); end if;
 end if;
 update public.players set last_seen=now() where id=u and room_id=r.id;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.submit_action(p_code text,p_choice text,p_target uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; balance int;
begin
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found or r.status<>'playing' then raise exception 'Game is not accepting choices'; end if;
 select coins into balance from public.players where id=u and room_id=r.id and active for update;
 if not found then raise exception 'Not an active player'; end if;
 if p_choice is null or p_choice not in ('search','steal','trap','guard','dig_deep','explore') then raise exception 'Invalid action'; end if;
 if exists(select 1 from public.actions where room_id=r.id and round_no=r.round_no and player_id=u) then raise exception 'Choice already locked'; end if;
 if p_choice='steal' and (p_target is null or p_target=u or not exists(
   select 1 from public.players where id=p_target and room_id=r.id and active)) then raise exception 'Choose a valid rival'; end if;
 if p_choice<>'steal' and p_target is not null then raise exception 'This action does not use a target'; end if;
 if p_choice in ('trap','guard','dig_deep','explore') and balance<1 then raise exception 'You need 1 coin for this action'; end if;
 insert into public.actions(room_id,round_no,player_id,choice,target_id) values(r.id,r.round_no,u,p_choice,p_target);
 if not exists(select 1 from public.players p where p.room_id=r.id and p.active
   and not exists(select 1 from public.actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id)) then
   perform public.resolve_round_internal(r.id,r.round_no);
 end if;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.rematch(p_code text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from public.rooms where code=upper(trim(p_code)) for update;
 if not found or r.host_id<>u or r.status<>'finished' then raise exception 'Only host can restart a finished game'; end if;
 delete from public.actions where room_id=r.id;
 delete from public.round_results where room_id=r.id;
 update public.players set coins=5,last_seen=now(),active=true,ready=false where room_id=r.id;
 update public.rooms set status='lobby',round_no=0 where id=r.id;
 return jsonb_build_object('ok',true);
end; $$;

-- Keep the original room-member RLS policies. Grant SELECT only on tables those policies filter; actions remain private.
grant select on public.rooms,public.players,public.round_results to authenticated;
revoke all on function public.resolve_round_internal(uuid,int) from public,anon,authenticated;
revoke all on function public.create_room(text,uuid),public.join_room(text,text),
  public.get_room(text),public.set_player_ready(text,boolean),public.start_game(text),
  public.heartbeat(text),public.submit_action(text,text,uuid),public.rematch(text) from public,anon;
grant execute on function public.create_room(text,uuid),public.join_room(text,text),
  public.get_room(text),public.set_player_ready(text,boolean),public.start_game(text),
  public.heartbeat(text),public.submit_action(text,text,uuid),public.rematch(text) to authenticated;
commit;
