-- Treasure Plots forward migration 003: reconcile the move RPCs with the existing per-room schema.
-- It does not change table columns, keys, foreign keys, constraints, RLS, or policies.
-- Preflight: confirm the supplied composite primary keys and required columns are present.
begin;
create or replace function public.resolve_round_internal(rid uuid,rn int)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
 r public.rooms%rowtype; a record; t record; protection text;
 n int; share_n int; rem_n int; amt int; rank_n int; success boolean; current_balance int;
 ev jsonb:='[]'::jsonb; cs jsonb; balances jsonb;
begin
 select * into r from public.rooms where id=rid for update;
 if not found then return; end if;
 if r.status<>'playing' or r.round_no<>rn or exists(select 1 from public.round_results where room_id=rid and round_no=rn) then return; end if;

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
     -- Read the current balance for every penalty so repeated Trap effects
     -- cannot spend the same snapshot coins twice or drive a thief negative.
     select coins into current_balance from public.players
       where room_id=rid and id=a.player_id for update;
     if found then amt:=least(2,greatest(current_balance,0)); else amt:=0; end if;
     if amt>0 then
       update public.players set coins=coins-amt
         where room_id=rid and id=a.player_id and coins>=amt;
       if not found then amt:=0; end if;
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

 -- Snapshot the remaining balances after all trap penalties; ordinary thefts use this shared balance.
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
         update public.players set coins=coins-amt where room_id=rid and id=t.target_id and coins>=amt;
         if not found then raise exception 'Coin invariant failed while resolving steal'; end if;
         update public.players set coins=coins+amt where room_id=rid and id=a.player_id;
         if not found then raise exception 'Coin invariant failed while crediting steal'; end if;
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

create or replace function public.submit_action(p_code text,p_choice text,p_target uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; balance int;
begin
 if u is null then raise exception 'Sign in required'; end if;
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
-- Keep submit_action authenticated-only; preserve resolver ACL for existing SECURITY DEFINER callers.
revoke all on function public.submit_action(text,text,uuid) from public,anon,authenticated;
grant execute on function public.submit_action(text,text,uuid) to authenticated,service_role;

commit;
