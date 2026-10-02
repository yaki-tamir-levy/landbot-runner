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

  -- 2.10.2026: open = NEW, REVIEWED, VIEWED (as the viewer, psychologist_notify
  -- and the history archive). Simulation patients (masked phone starting
  -- 888 or 999) stay in the report, flagged "sim", and are counted apart.
  return (
    with rr as (
      select r.id, r.severity, r.match_method, r.short_risk,
             case when r.time_key ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}'
                  then r.time_key::timestamptz end as tk,
             u.phone as mphone,
             (regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') ~ '^(888|999)') as sim,
             coalesce(p.name, '(לא משויך)') as psychologist
        from public.risk_reviews_v2 r
        left join public.users_information_v2 u on u.patient_code = r.patient_code
        left join public.psychologists_v2 p
               on regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
                = regexp_replace(coalesce(u.psychologist, ''), '\D', '', 'g')
              and coalesce(u.psychologist, '') <> ''
       where r.status in ('NEW', 'REVIEWED', 'VIEWED')
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
      'open_total', (select count(*) from rr where not sim),
      'sim_open_total', (select count(*) from rr where sim),
      'overdue_total', (select count(*) from od where not sim),
      'sim_overdue_total', (select count(*) from od where sim),
      'by_psychologist', (select coalesce(jsonb_agg(jsonb_build_object(
                             'psychologist', psychologist, 'open', n_open, 'overdue', n_over,
                             'sim_open', n_sim_open, 'sim_overdue', n_sim_over,
                             'oldest_days', oldest) order by n_over desc, psychologist), '[]'::jsonb)
                            from (select rr.psychologist,
                                         count(*) filter (where not rr.sim) n_open,
                                         count(*) filter (where not rr.sim and rr.tk < now() - interval '24 hours') n_over,
                                         count(*) filter (where rr.sim) n_sim_open,
                                         count(*) filter (where rr.sim and rr.tk < now() - interval '24 hours') n_sim_over,
                                         max(floor(extract(epoch from (now() - rr.tk)) / 86400))::int oldest
                                    from rr group by rr.psychologist) g),
      'overdue_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object(
                   'psychologist', psychologist, 'severity', severity, 'method', match_method,
                   'text', short_risk, 'phone', mphone, 'sim', sim, 'at', tk, 'days', days)
                 order by psychologist, tk), '[]'::jsonb) from od) end,
      'open_items', case when v_full then
        (select coalesce(jsonb_agg(jsonb_build_object(
                   'psychologist', psychologist, 'severity', severity, 'method', match_method,
                   'text', short_risk, 'phone', mphone, 'sim', sim, 'at', tk, 'days', days)
                 order by case severity when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
                          tk desc nulls last), '[]'::jsonb) from al) end)
  );
end;
$function$;
