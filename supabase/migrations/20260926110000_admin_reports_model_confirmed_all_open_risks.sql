-- 26.9.2026, approved by Jacob:
-- (a) Only model-confirmed findings (match_method = '1') count as risks in
--     every report. Phrase-list findings (match_method = '2') are excluded.
-- (b) Every open risk is reported regardless of age: admin_report_open_risks_v2
--     gains 'open_items' (all open findings, with days waiting). The existing
--     keys, including 'overdue_items', are kept, so the current report script
--     keeps working until it is switched to 'open_items'.
-- Signatures, SECURITY DEFINER, search_path and grants unchanged.

CREATE OR REPLACE FUNCTION public.admin_report_open_risks_v2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
declare
  v_full boolean;
begin
  v_full := coalesce((select btrim(value) from public.app_config
                      where key = 'admin_daily_report_detail'), '') = 'full';

  return (
    with rr as (
      select r.id, r.severity, r.match_method, r.short_risk,
             case when r.time_key ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}'
                  then r.time_key::timestamptz end as tk,
             u.phone as mphone,
             coalesce(p.name, '(לא משויך)') as psychologist
        from public.risk_reviews_v2 r
        left join public.users_information_v2 u on u.patient_code = r.patient_code
        left join public.psychologists_v2 p
               on regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
                = regexp_replace(coalesce(u.psychologist, ''), '\D', '', 'g')
              and coalesce(u.psychologist, '') <> ''
       where r.status = 'NEW'
         and r.match_method = '1'),
    al as (
      select *, case when tk is not null
                     then floor(extract(epoch from (now() - tk)) / 86400)::int end as days
        from rr),
    od as (
      select * from al
       where tk is not null and tk < now() - interval '24 hours')
    select jsonb_build_object(
      'detail', case when v_full then 'full' else 'counts' end,
      'open_total', (select count(*) from rr),
      'overdue_total', (select count(*) from od),
      'by_psychologist', (select coalesce(jsonb_agg(jsonb_build_object(
                             'psychologist', psychologist, 'open', n_open, 'overdue', n_over,
                             'oldest_days', oldest) order by n_over desc, psychologist), '[]'::jsonb)
                            from (select rr.psychologist, count(*) n_open,
                                         count(*) filter (where rr.tk < now() - interval '24 hours') n_over,
                                         max(floor(extract(epoch from (now() - rr.tk)) / 86400))::int oldest
                                    from rr group by rr.psychologist) g),
      'overdue_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object(
                   'psychologist', psychologist, 'severity', severity, 'method', match_method,
                   'text', short_risk, 'phone', mphone, 'at', tk, 'days', days)
                 order by psychologist, tk), '[]'::jsonb) from od) end,
      'open_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object(
                   'psychologist', psychologist, 'severity', severity, 'method', match_method,
                   'text', short_risk, 'phone', mphone, 'at', tk, 'days', days)
                 order by case severity when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
                          tk desc nulls last), '[]'::jsonb) from al) end)
  );
end;
$function$;

-- admin_daily_report_v2 is 19 KB; only one condition changes, so it is
-- patched in place from its live definition instead of being retyped.
do $patch$
declare
  v_def text;
  v_old constant text := 'where x.tk >= v_from and x.tk < v_to)';
  v_new constant text := 'where x.tk >= v_from and x.tk < v_to and x.match_method = ''1'')';
begin
  v_def := pg_get_functiondef('public.admin_daily_report_v2(date)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'admin_daily_report_v2: anchor not found exactly once';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;
