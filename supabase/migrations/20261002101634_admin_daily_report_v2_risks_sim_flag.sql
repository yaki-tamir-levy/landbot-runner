do $do$
declare
  d   text := pg_get_functiondef('public.admin_daily_report_v2(date)'::regprocedure);
  o1  text := $o$      select x.*, u.phone as mphone
        from (select *, case when time_key$o$;
  n1  text := $n$      select x.*, u.phone as mphone,
             (regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') ~ '^(888|999)') as sim
        from (select *, case when time_key$n$;
  o2  text := $o$      'count', (select count(*) from rr),
      'by_severity', (select coalesce(jsonb_object_agg(coalesce(severity, '(none)'), n), '{}'::jsonb)
                        from (select severity, count(*) n from rr group by severity) s),
      'by_method', (select coalesce(jsonb_object_agg(coalesce(match_method, '(none)'), n), '{}'::jsonb)
                      from (select match_method, count(*) n from rr group by match_method) m),$o$;
  n2  text := $n$      -- 2.10.2026: simulation patients (masked phone 888/999) stay, flagged
      -- "sim"; every count below is without them, sim_count holds them apart.
      'count', (select count(*) from rr where not sim),
      'sim_count', (select count(*) from rr where sim),
      'by_severity', (select coalesce(jsonb_object_agg(coalesce(severity, '(none)'), n), '{}'::jsonb)
                        from (select severity, count(*) n from rr where not sim group by severity) s),
      'by_method', (select coalesce(jsonb_object_agg(coalesce(match_method, '(none)'), n), '{}'::jsonb)
                      from (select match_method, count(*) n from rr where not sim group by match_method) m),$n$;
  o3  text := $o$                  'notes', review_notes, 'at', tk) order by tk), '[]'::jsonb) from rr) end)$o$;
  n3  text := $n$                  'notes', review_notes, 'sim', sim, 'at', tk) order by tk), '[]'::jsonb) from rr) end)$n$;
begin
  if (length(d) - length(replace(d, o1, ''))) / length(o1) <> 1 then raise exception 'anchor 1 count'; end if;
  if (length(d) - length(replace(d, o2, ''))) / length(o2) <> 1 then raise exception 'anchor 2 count'; end if;
  if (length(d) - length(replace(d, o3, ''))) / length(o3) <> 1 then raise exception 'anchor 3 count'; end if;
  d := replace(replace(replace(d, o1, n1), o2, n2), o3, n3);
  execute d;
end
$do$;
