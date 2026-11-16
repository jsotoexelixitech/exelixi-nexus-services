-- Blindaje del cobro del cotizador RC antes de producción («nunca emitir sin pago»). Aditivo: no toca datos.
--
-- 1) Una referencia de pago paga una sola cotización: índice único sobre crc_pago.pagado.referencia.
--    Cierra la carrera de dos avisos simultáneos con la misma referencia en dos cotizaciones distintas.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cotizacion_rc_pago_referencia"
    ON "cotizacion_rc" ((("crc_pago" -> 'pagado') ->> 'referencia'))
    WHERE (("crc_pago" -> 'pagado') ->> 'referencia') IS NOT NULL;

-- 2) La cotización guardada queda congelada: el JSON (primas, opciones y datos de emisión), el producto, la moneda y
--    el código no se pueden cambiar después del INSERT. El checkout cobra solo lo que quedó guardado.
CREATE OR REPLACE FUNCTION "cotizacion_rc_congelada"() RETURNS trigger AS $$
BEGIN
    IF NEW."crc_datos" IS DISTINCT FROM OLD."crc_datos"
       OR NEW."crc_producto" IS DISTINCT FROM OLD."crc_producto"
       OR NEW."crc_moneda" IS DISTINCT FROM OLD."crc_moneda"
       OR NEW."crc_codigo" IS DISTINCT FROM OLD."crc_codigo" THEN
        RAISE EXCEPTION 'cotizacion_rc %: la cotización guardada no se puede modificar (datos, producto, moneda o código)', OLD."crc_codigo";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_cotizacion_rc_congelada" ON "cotizacion_rc";
CREATE TRIGGER "trg_cotizacion_rc_congelada"
    BEFORE UPDATE ON "cotizacion_rc"
    FOR EACH ROW EXECUTE PROCEDURE "cotizacion_rc_congelada"();
