-- ═══════════════════════════════════════════════════════════════
-- OptiQ — Setup Supabase Auth
-- À coller dans : Supabase → SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════════

-- 1) Table des rôles liée aux comptes Auth ----------------------------------
create table if not exists public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  role  text not null default 'tech',   -- 'admin' ou 'tech'
  nom   text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Chacun peut lire son propre profil
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles for select
  using ( auth.uid() = id );

-- 2) Création auto d'un profil à chaque nouvel utilisateur -------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, nom)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Marquer ton compte comme admin -----------------------------------------
-- ⚠️ Remplace l'email par celui que tu as utilisé pour créer le compte admin
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'johannmonlouib@gmail.com');

-- Vérification (doit afficher ton compte avec role = admin)
select p.role, p.nom, u.email
from public.profiles p join auth.users u on u.id = p.id;
