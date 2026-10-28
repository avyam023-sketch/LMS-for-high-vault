-- Learners buy from Canada, so the course is priced in Canadian dollars: $89 CAD.
-- Only changes the course if it still has the original US$89 price, so a price set in the admin is kept.
UPDATE courses
   SET currency = 'cad',
       faqs = replace(faqs::text, 'US$89, paid once.', '$89 CAD, paid once.')::jsonb,
       updated_at = now()
 WHERE slug = 'food-handler-certification' AND price_cents = 8900 AND currency = 'usd';
