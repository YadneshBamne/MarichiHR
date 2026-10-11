-- Owner confirmed the gratuity parameters on 2026-10-11
UPDATE "statutory_tables" SET "verified" = true, "sourceNote" = "sourceNote" || ' Confirmed by the company owner on 2026-10-11.' WHERE "code" IN ('IN_GRATUITY', 'ZM_GRATUITY') AND "effectiveFrom" IN ('2018-03-29', '2019-05-09');
