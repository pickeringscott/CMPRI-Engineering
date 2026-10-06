REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM authenticated;
GRANT INSERT ON TABLE public.work_orders TO authenticated;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_hotel_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_hotel(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cmpri_can_view_work_orders(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cmpri_can_submit_work_orders(uuid) TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
