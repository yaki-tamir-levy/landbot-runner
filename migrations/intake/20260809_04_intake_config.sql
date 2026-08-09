-- המטפל של מסלול הקבלה הוא הגדרה, לא קוד.
-- החלפתו היא עדכון ערך אחד, בלי לגעת בשום פונקציה.

insert into public.app_config (key, value)
values ('intake_psychologist_phone', '0547558740')
on conflict (key) do update set value = excluded.value;
