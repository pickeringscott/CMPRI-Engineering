begin;

alter table public.work_orders
  drop constraint if exists work_orders_creator_source_check;

alter table public.work_orders
  add constraint work_orders_creator_source_check check (
    creator_source = any (array[
      'signed_in_user'::text,
      'shared_account_entry'::text,
      'front_desk_pending_verification'::text,
      'department_pending_verification'::text,
      'import'::text,
      'admin_correction'::text,
      'draft_submitted_by_supervisor'::text
    ])
  );

commit;
