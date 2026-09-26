-- 26.9.2026, approved by Jacob: the conversations section of the 09:00
-- report shows only turns the corrector rewrote, with the answer before and
-- after the rewrite. Additive: each session gains 'rewrites_day' and
-- 'rewrite_items'; the existing 'items' key is kept until the report script
-- no longer reads it. Answers are cut at 1500 characters (the existing
-- 'items' cut at 500, which could hide the part that was rewritten).
do $patch$
declare
  v_def text;
  v_old constant text :=
    '''turns_total'', (select count(*) from corrector_test_log c where c.conversation_id = a.conversation_id),';
  v_new constant text :=
    '''turns_total'', (select count(*) from corrector_test_log c where c.conversation_id = a.conversation_id),
                  ''rewrites_day'', (select count(*) from ct where ct.conversation_id = a.conversation_id
                                      and ct.corrector_decision = ''REWRITE''),
                  ''rewrite_items'', (select coalesce(jsonb_agg(jsonb_build_object(''at'', ct.created_at,
                              ''q'', left(ct.question, 1500),
                              ''before'', left(ct.candidate_answer, 1500),
                              ''after'', left(ct.corrected_answer, 1500),
                              ''reasons'', ct.reason_codes)
                              order by ct.created_at), ''[]''::jsonb)
                              from ct where ct.conversation_id = a.conversation_id
                                        and ct.corrector_decision = ''REWRITE''),';
begin
  v_def := pg_get_functiondef('public.admin_daily_report_v2(date)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'admin_daily_report_v2: anchor not found exactly once';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;
