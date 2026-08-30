-- Operator intake may re-analyze an unchanged retained revision after an
-- analysis implementation upgrade. Superseding its prior run is intake
-- bookkeeping only; article tables remain explicitly unavailable to this role.
GRANT UPDATE ON analysis_runs TO gameintel_operator;
