ALTER TABLE transactions ADD COLUMN spending_month TEXT
  CHECK (spending_month IS NULL OR
    (spending_month GLOB '[1-9][0-9][0-9][0-9]-[0-1][0-9]'
     AND spending_month >= '1900-01' AND substr(spending_month, 6, 2) BETWEEN '01' AND '12'
     AND (split_kind IS NULL OR split_kind <> 'month')));
