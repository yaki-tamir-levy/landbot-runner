-- הוספת שני מפתחות המסלול לרשימת הפרומפטים המשותפים.
-- שינוי יחיד בפונקציה קיימת: הרשימה בשורה אחת.
-- הרקע: מפתח ללא קידומת מקבל אוטומטית nlp_ ולכן intake היה מחזיר NULL בשקט.
--
-- אומת אחרי ההרצה ב-9.8.2026:
--   ההרשאות נותרו זהות לחלוטין למצב שלפני
--   (=X/postgres | postgres | anon | authenticated | service_role)
--   ולכן לא נדרשה שלילה. בכל שינוי עתידי — לבדוק שוב, אין להסתמך על כך.
--
-- אומת גם שכל חמשת המפתחות הקיימים ממשיכים להיפתר: therapist בשני המסלולים,
-- corrector בקליני, ו-summary.

CREATE OR REPLACE FUNCTION public.get_prompt_v2(p_prompt_key text, p_therapy text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_key text;
  v_therapy text;
begin
  v_key := btrim(coalesce(p_prompt_key, ''));

  if v_key = '' then
    return null;
  end if;

  -- shared prompts: never carry a track prefix
  if v_key in ('risk', 'summary', 'course_guide', 'intake', 'intake_decision') then
    return (select user_text from public.prompt_information_v2 where prompt_key = v_key limit 1);
  end if;

  -- already prefixed: use as received
  if v_key like 'nlp\_%' or v_key like 'clinic\_%' then
    return (select user_text from public.prompt_information_v2 where prompt_key = v_key limit 1);
  end if;

  v_therapy := upper(btrim(coalesce(p_therapy, '')));

  if v_therapy = 'CLINIC' then
    v_key := 'clinic_' || v_key;
  else
    v_key := 'nlp_' || v_key;
  end if;

  return (select user_text from public.prompt_information_v2 where prompt_key = v_key limit 1);
end;
$function$;
