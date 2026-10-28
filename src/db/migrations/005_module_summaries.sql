-- A one-line summary per module, shown on the course page's module cards. Editable in the admin.
ALTER TABLE modules ADD COLUMN summary text NOT NULL DEFAULT '';

-- Fill in the summaries for the standard food handler modules on existing installs.
UPDATE modules m SET summary = v.summary
  FROM (VALUES
    ('Food safety foundations', 'Why food safety matters, who is most at risk, and the responsibilities every food handler shares.'),
    ('Microorganisms and foodborne illness', 'How bacteria, viruses and parasites make people sick, and the conditions that let them multiply.'),
    ('Handwashing and glove use', 'The correct way to wash your hands, when to do it, and how to use gloves without spreading germs.'),
    ('Illness, injuries and work attire', 'When you must stay away from food, how to handle cuts and burns, and what to wear on shift.'),
    ('The danger zone and safe cooking', 'The 4°C to 60°C danger zone, safe cooking temperatures and how to use a probe thermometer.'),
    ('Cooling, reheating, holding and thawing', 'Two-stage cooling, reheating to safe temperatures, hot and cold holding, and safe thawing.'),
    ('Receiving, storage and cross-contamination', 'Checking deliveries, storing food in the right order, and keeping raw and ready-to-eat food apart.'),
    ('Food allergens', 'Canada’s priority allergens, preventing cross-contact, and answering customers’ allergy questions accurately.'),
    ('Cleaning and sanitizing', 'The difference between cleaning and sanitizing, sanitizer strength and contact time, and dishwashing.'),
    ('Pest control and food safety systems', 'Spotting and preventing pests, and the basics of HACCP and food safety plans.')
  ) AS v(title, summary)
 WHERE m.title = v.title AND m.summary = '';
