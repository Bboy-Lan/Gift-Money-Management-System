-- Only record future status transitions. Existing feedback is not changed.
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
-- next --
CREATE OR REPLACE FUNCTION public.feedback_status_changed_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at = clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
-- next --
DROP TRIGGER IF EXISTS feedback_status_changed_at_trigger ON public.feedback;
-- next --
CREATE TRIGGER feedback_status_changed_at_trigger BEFORE UPDATE OF status ON public.feedback
FOR EACH ROW EXECUTE FUNCTION public.feedback_status_changed_at();
