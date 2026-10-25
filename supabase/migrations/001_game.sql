create table if not exists public.rooms (id uuid primary key default gen_random_uuid(), code text not null unique, host_id uuid not null, status text not null default 'lobby' check(status in ('lobby','playing','finished')), round_no int not null default 0, created_at timestamptz not null default now());
create table if not exists public.players (id uuid primary key, room_id uuid not null references public.rooms(id) on delete cascade, name text not null check(char_length(name) between 1 and 18), coins int not null default 5 check(coins>=0), joined_at timestamptz not null default now(), last_seen timestamptz not null default now(), active boolean not null default true);
create table if not exists public.actions (room_id uuid not null references public.rooms(id) on delete cascade, round_no int not null, player_id uuid not null references public.players(id) on delete cascade, choice text not null check(choice in ('search','steal','trap')), target_id uuid references public.players(id), submitted_at timestamptz not null default now(), primary key(room_id,round_no,player_id), check((choice='steal' and target_id is not null) or (choice<>'steal' and target_id is null)));
create table if not exists public.round_results (room_id uuid not null references public.rooms(id) on delete cascade, round_no int not null, payload jsonb not null, primary key(room_id,round_no));
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.actions enable row level security;
alter table public.round_results enable row level security;
revoke all on public.rooms,public.players,public.actions,public.round_results from anon,authenticated;

create or replace function public.create_room(p_name text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; c text;
begin
 if u is null then raise exception 'Sign in required'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 18 then raise exception 'Name must be 1–18 characters'; end if;
 loop c:=upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)); exit when not exists(select 1 from rooms where code=c); end loop;
 insert into rooms(code,host_id) values(c,u) returning * into r;
 insert into players(id,room_id,name) values(u,r.id,trim(p_name));
 return jsonb_build_object('code',r.code);
end; $$;

create or replace function public.join_room(p_code text,p_name text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 if u is null then raise exception 'Sign in required'; end if;
 if p_name is null or length(trim(p_name)) not between 1 and 18 then raise exception 'Name must be 1–18 characters'; end if;
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found then raise exception 'Room code not found'; end if;
 if exists(select 1 from players where id=u and room_id=r.id) then
  if r.status='playing' and exists(select 1 from players p where p.id=u and p.room_id=r.id and p.last_seen<now()-interval '90 seconds') and not exists(select 1 from actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=u) then perform public.resolve_round_internal(r.id,r.round_no); end if;
  update players set last_seen=now(),active=true where id=u; return jsonb_build_object('code',r.code);
 end if;
 if r.status<>'lobby' then raise exception 'This game has already started'; end if;
 if (select count(*) from players where room_id=r.id and active)>=8 then raise exception 'Room is full'; end if;
 insert into players(id,room_id,name) values(u,r.id,trim(p_name));
 return jsonb_build_object('code',r.code);
end; $$;

create or replace function public.get_room(p_code text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from rooms where code=upper(trim(p_code));
 if not found then raise exception 'Room code not found'; end if;
 if not exists(select 1 from players where id=u and room_id=r.id) then raise exception 'Not a room member'; end if;
 return jsonb_build_object(
 'id',r.id,'code',r.code,'host_id',r.host_id,'status',r.status,'round_no',r.round_no,
 'players',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'coins',p.coins,'active',p.active) order by p.joined_at),'[]'::jsonb) from players p where p.room_id=r.id and p.active),
 'submitted',(select count(*) from actions a where a.room_id=r.id and a.round_no=r.round_no),
 'my_action',(select jsonb_build_object('choice',a.choice,'target_id',a.target_id) from actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=u),
 'result',(select payload from round_results where room_id=r.id and round_no=r.round_no),
 'all_results',(select coalesce(jsonb_agg(payload order by round_no),'[]'::jsonb) from round_results where room_id=r.id));
end; $$;

create or replace function public.start_game(p_code text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found or r.host_id<>u then raise exception 'Only host can start'; end if;
 if r.status<>'lobby' then raise exception 'Game already started'; end if;
 if (select count(*) from players where room_id=r.id and active)<2 then raise exception 'At least 2 players needed'; end if;
 update players set last_seen=now() where room_id=r.id and active;
 update rooms set status='playing',round_no=1 where id=r.id; return jsonb_build_object('ok',true);
end; $$;

create or replace function public.resolve_round_internal(rid uuid,rn int) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms%rowtype; a record; t record; n int; share_n int; rem_n int; amt int; rank_n int; ev jsonb:='[]'::jsonb; cs jsonb; balances jsonb;
begin
 select * into r from rooms where id=rid for update;
 if r.status<>'playing' or r.round_no<>rn or exists(select 1 from round_results where room_id=rid and round_no=rn) then return; end if;
 select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into balances from players where room_id=rid and active;
 -- Apply search and trap costs, then distribute steals from each target's single pre-transfer balance snapshot.
 for a in select act.*,p.name from actions act join players p on p.id=act.player_id where act.room_id=rid and act.round_no=rn order by act.player_id loop
  if a.choice='search' then update players set coins=coins+2 where id=a.player_id; ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','search','delta',2));
  elsif a.choice='trap' then update players set coins=greatest(0,coins-1) where id=a.player_id; ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','trap','delta',-1));
  else ev:=ev||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'name',a.name,'choice','steal','target_id',a.target_id,'target_name',(select name from players where id=a.target_id))); end if;
 end loop;
 for t in select distinct act.target_id,p.name,(balances->>act.target_id::text)::int as coins from actions act join players p on p.id=act.target_id where act.room_id=rid and act.round_no=rn and act.choice='steal' loop
  if exists(select 1 from actions where room_id=rid and round_no=rn and player_id=t.target_id and choice='trap') then
   update players set coins=coins+2 where id=t.target_id;
   for a in select act.player_id,(balances->>act.player_id::text)::int as coins from actions act join players p on p.id=act.player_id where act.room_id=rid and act.round_no=rn and act.choice='steal' and act.target_id=t.target_id loop amt:=least(2,a.coins); update players set coins=coins-amt where id=a.player_id; ev:=ev||jsonb_build_array(jsonb_build_object('type','trap_penalty','thief_id',a.player_id,'thief_name',(select name from players where id=a.player_id),'target_id',t.target_id,'target_name',t.name,'amount',amt)); end loop;
   ev:=ev||jsonb_build_array(jsonb_build_object('type','trap_blocked','target_id',t.target_id,'target_name',t.name,'count',(select count(*) from actions where room_id=rid and round_no=rn and choice='steal' and target_id=t.target_id),'delta',2));
  else
   select count(*) into n from actions where room_id=rid and round_no=rn and choice='steal' and target_id=t.target_id;
   share_n:=least(t.coins,2*n)/n; rem_n:=least(t.coins,2*n)%n; rank_n:=0;
   for a in select player_id from actions where room_id=rid and round_no=rn and choice='steal' and target_id=t.target_id order by md5(player_id::text||rn::text) loop
    amt:=share_n+case when rank_n<rem_n then 1 else 0 end; rank_n:=rank_n+1;
    update players set coins=coins+amt where id=a.player_id;
    update players set coins=greatest(0,coins-amt) where id=t.target_id;
    ev:=ev||jsonb_build_array(jsonb_build_object('type','theft','thief_id',a.player_id,'target_id',t.target_id,'target_name',t.name,'amount',amt));
   end loop;
  end if;
 end loop;
 select coalesce(jsonb_object_agg(id::text,coins),'{}'::jsonb) into cs from players where room_id=rid and active;
 insert into round_results values(rid,rn,jsonb_build_object('round',rn,'events',ev,'coins',cs));
 if rn>=3 then update rooms set status='finished' where id=rid; else update rooms set round_no=rn+1 where id=rid; end if;
end; $$;

create or replace function public.heartbeat(p_code text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype; missing_n int; timed_out boolean;
begin
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found or not exists(select 1 from players where id=u and room_id=r.id and active) then raise exception 'Room membership expired'; end if;
 if r.status='playing' then
  select count(*) into missing_n from players p where p.room_id=r.id and p.active and not exists(select 1 from actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id);
  select exists(select 1 from players p where p.room_id=r.id and p.active and p.last_seen<now()-interval '90 seconds' and not exists(select 1 from actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id)) into timed_out;
  if missing_n=0 or timed_out then perform public.resolve_round_internal(r.id,r.round_no); end if;
 end if;
 update players set last_seen=now() where id=u;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.submit_action(p_code text,p_choice text,p_target uuid default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found or r.status<>'playing' then raise exception 'Game is not accepting choices'; end if;
 if not exists(select 1 from players where id=u and room_id=r.id and active) then raise exception 'Not an active player'; end if;
 if p_choice not in ('search','steal','trap') then raise exception 'Invalid action'; end if;
 if exists(select 1 from actions where room_id=r.id and round_no=r.round_no and player_id=u) then raise exception 'Choice already locked'; end if;
 if p_choice='steal' and (p_target is null or p_target=u or not exists(select 1 from players where id=p_target and room_id=r.id and active)) then raise exception 'Choose a valid rival'; end if;
 if p_choice='trap' and (select coins from players where id=u)<1 then raise exception 'You need 1 coin to set a trap'; end if;
 insert into actions(room_id,round_no,player_id,choice,target_id) values(r.id,r.round_no,u,p_choice,p_target);
 if not exists(select 1 from players p where p.room_id=r.id and p.active and not exists(select 1 from actions a where a.room_id=r.id and a.round_no=r.round_no and a.player_id=p.id)) then perform public.resolve_round_internal(r.id,r.round_no); end if;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.rematch(p_code text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); r public.rooms%rowtype;
begin
 select * into r from rooms where code=upper(trim(p_code)) for update;
 if not found or r.host_id<>u or r.status<>'finished' then raise exception 'Only host can restart a finished game'; end if;
 delete from actions where room_id=r.id; delete from round_results where room_id=r.id;
 update players set coins=5,last_seen=now(),active=true where room_id=r.id;
 update rooms set status='lobby',round_no=0 where id=r.id; return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.resolve_round_internal(uuid,int) from public,anon,authenticated;
revoke all on function public.create_room(text),public.join_room(text,text),public.get_room(text),public.start_game(text),public.heartbeat(text),public.submit_action(text,text,uuid),public.rematch(text) from public,anon;
grant execute on function public.create_room(text),public.join_room(text,text),public.get_room(text),public.start_game(text),public.heartbeat(text),public.submit_action(text,text,uuid),public.rematch(text) to authenticated;

do $$ begin
 alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
 alter publication supabase_realtime add table public.players;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
 alter publication supabase_realtime add table public.round_results;
exception when duplicate_object then null; when undefined_object then null; end $$;

drop policy if exists "members read rooms" on public.rooms;
drop policy if exists "members read players" on public.players;
drop policy if exists "members read results" on public.round_results;
create or replace function public.is_room_member(rid uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select exists(select 1 from public.players p where p.room_id=rid and p.id=auth.uid() and p.active) $$;
revoke all on function public.is_room_member(uuid) from public,anon;
grant execute on function public.is_room_member(uuid) to authenticated;

-- Multiple rival steals can each request 2 coins. They split min(balance, 2 × thieves)
-- evenly, with any remainder assigned by the stable hash order below.




create policy "members read rooms" on public.rooms for select to authenticated using (public.is_room_member(id));
create policy "members read players" on public.players for select to authenticated using (public.is_room_member(room_id));
create policy "members read results" on public.round_results for select to authenticated using (public.is_room_member(room_id));
