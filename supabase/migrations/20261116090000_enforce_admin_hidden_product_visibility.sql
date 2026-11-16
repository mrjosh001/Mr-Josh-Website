CREATE OR REPLACE FUNCTION public.enforce_product_admin_hidden_visibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.admin_hidden IS TRUE THEN
    NEW.is_available := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_admin_hidden_visibility ON public.products;

CREATE TRIGGER trg_enforce_product_admin_hidden_visibility
BEFORE INSERT OR UPDATE OF admin_hidden, is_available
ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.enforce_product_admin_hidden_visibility();

UPDATE public.products
SET is_available = FALSE
WHERE admin_hidden IS TRUE
  AND is_available IS DISTINCT FROM FALSE;
