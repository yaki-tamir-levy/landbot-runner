create or replace function public.conversation_sources_for_viewer()
returns table (conversation_id uuid, source text)
language sql
security definer
set search_path to 'public'
as $$
  select s.conversation_id, s.source
  from public.conversations_session_v2 s
  where current_user_is_admin()
     or exists (
       select 1
       from public.users_information_v2 u
       where u.patient_code = s.patient_code
         and u.psychologist is not null
         and u.psychologist = current_psychologist_phone()
     )
$$;

revoke execute on function public.conversation_sources_for_viewer() from public;
revoke execute on function public.conversation_sources_for_viewer() from anon;
grant  execute on function public.conversation_sources_for_viewer() to authenticated;
