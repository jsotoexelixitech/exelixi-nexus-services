-- Puntaje de salud con decimales (antes INTEGER truncaba 12.5 → 12).
ALTER TABLE "funeral_submission"
  ALTER COLUMN "funeral_submission_score_total" TYPE DOUBLE PRECISION
  USING "funeral_submission_score_total"::double precision;
