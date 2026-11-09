-- Supplier is provenance, not a prerequisite for inventory identity.
-- Existing mapped lines and inventory quantities are never changed here.
CREATE OR REPLACE FUNCTION public.cmpri_auto_catalog_po_line()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path TO public, pg_temp AS $function$
DECLARE
 o public.cmpri_po_orders;
 item public.cmpri_inventory_items;
 identity_key text;
 product_description text;
 candidates integer;
BEGIN
 IF new.inventory_item_id IS NOT NULL THEN RETURN new; END IF;
 SELECT * INTO o FROM public.cmpri_po_orders WHERE id=new.order_id AND hotel_id=new.hotel_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'PO property identity mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public.cmpri_po_receipts WHERE hotel_id=new.hotel_id AND line_id=new.id) THEN
  RAISE EXCEPTION 'An unmapped line with receipts requires explicit history review';
 END IF;
 product_description=regexp_replace(trim(new.description),'[[:space:]]+',' ','g');
 IF coalesce(trim(new.sku),'')='' OR coalesce(trim(new.uom),'')='' OR coalesce(product_description,'')='' THEN
  new.catalog_review_note='Catalog review required: product description, item identifier and order unit must be established.';
  RETURN new;
 END IF;
 -- Exact product evidence only: no supplier requirement, SKU-only merges,
 -- inferred package contents, unit aliases, URL rewriting or fuzzy matching.
 identity_key=jsonb_build_array('po-product-v2',new.sku,new.uom,product_description)::text;
 PERFORM pg_advisory_xact_lock(hashtextextended(new.hotel_id::text||identity_key,0));
 SELECT * INTO item FROM public.cmpri_inventory_items
 WHERE hotel_id=new.hotel_id AND po_catalog_key=identity_key FOR UPDATE;
 IF NOT FOUND THEN
  SELECT count(*) INTO candidates FROM public.cmpri_inventory_items
  WHERE hotel_id=new.hotel_id AND sku=new.sku AND unit_of_measure=new.uom
   AND regexp_replace(trim(description),'[[:space:]]+',' ','g')=product_description;
  IF candidates>1 THEN
   new.catalog_review_note='Catalog review required: multiple inventory identities match this exact product and unit.';
   RETURN new;
  ELSIF candidates=1 THEN
   SELECT * INTO item FROM public.cmpri_inventory_items
   WHERE hotel_id=new.hotel_id AND sku=new.sku AND unit_of_measure=new.uom
    AND regexp_replace(trim(description),'[[:space:]]+',' ','g')=product_description FOR UPDATE;
  ELSE
   INSERT INTO public.cmpri_inventory_items
    (hotel_id,po_catalog_key,item_name,name,description,sku,vendor_sku,product_url,unit_of_measure,quantity_on_hand,created_by)
   VALUES(new.hotel_id,identity_key,
    CASE WHEN new.description ~ '^https?://' THEN new.sku ELSE new.description END,
    CASE WHEN new.description ~ '^https?://' THEN new.sku ELSE new.description END,
    new.description,new.sku,new.sku,
    CASE WHEN new.description ~ '^https?://' THEN new.description ELSE '' END,
    new.uom,0,o.created_by) RETURNING * INTO item;
  END IF;
 END IF;
 IF NOT item.active OR item.unit_of_measure IS DISTINCT FROM new.uom OR item.sku IS DISTINCT FROM new.sku
  OR regexp_replace(trim(item.description),'[[:space:]]+',' ','g') IS DISTINCT FROM product_description THEN
  new.catalog_review_note='Catalog review required: matching product identity is inactive or its product/unit changed.';
  RETURN new;
 END IF;
 new.inventory_item_id=item.id;
 new.units_per_order_unit=1;
 new.catalog_review_note=null;
 RETURN new;
END $function$;

