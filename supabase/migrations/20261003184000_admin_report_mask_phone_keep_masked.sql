-- 20261003184000_admin_report_mask_phone_keep_masked.sql
-- From 3.10.2026 runtime-corrected-response writes an already masked phone
-- (NNN***NNN) to corrector_test_log.phone instead of the full phone.
-- admin_report_mask_phone kept only the digits of its input, so a masked
-- value "052***789" came out as "052789". A value that already contains an
-- asterisk is now returned as it is. Full phones are masked exactly as before.
-- Signature, volatility, search_path and grants are unchanged.
--
-- Rollback: the previous body is the same without the "when p ~ '\*' then p" line.

create or replace function public.admin_report_mask_phone(p text)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $function$
  select case
    when p is null then null
    when p ~ '\*' then p
    when length(regexp_replace(p, '[^0-9]', '', 'g')) <= 6 then regexp_replace(p, '[^0-9]', '', 'g')
    else left(regexp_replace(p, '[^0-9]', '', 'g'), 3) || '***' || right(regexp_replace(p, '[^0-9]', '', 'g'), 3)
  end
$function$;
