-- Stop producing work for the retired workbook integration; retain historical queue rows.
DROP TRIGGER IF EXISTS cmpri_room_ranker_sync_enqueue ON public.work_orders;
