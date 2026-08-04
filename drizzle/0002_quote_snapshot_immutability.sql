CREATE OR REPLACE FUNCTION prevent_delivery_quote_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(OLD) - ARRAY[
    'status', 'notes', 'route_distance_km', 'route_duration_min',
    'external_km', 'base_price', 'external_surcharge', 'total_price'
  ])
    IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY[
      'status', 'notes', 'route_distance_km', 'route_duration_min',
      'external_km', 'base_price', 'external_surcharge', 'total_price'
    ]) THEN
    RAISE EXCEPTION 'delivery quote calculation snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER delivery_quotes_immutable_snapshot
BEFORE UPDATE ON delivery_quotes
FOR EACH ROW
EXECUTE FUNCTION prevent_delivery_quote_snapshot_change();
