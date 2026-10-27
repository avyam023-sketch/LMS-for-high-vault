// Starter content for the Food Handler Certification course: 10 modules, each with
// one chapter (video + reading) and a short quiz, followed by a proctored final exam.
// Figures follow Health Canada guidance and Ontario's Food Premises Regulation (O. Reg. 493/17).
// Review against your provincial requirements before going live; admins can edit everything in the dashboard.

export const course = {
  "slug": "food-handler-certification",
  "title": "Food Handler Certification",
  "subtitle": "Learn to prevent foodborne illness in any food business: hygiene, temperature control, cross-contamination, allergens, cleaning and sanitizing. Finish online and download your certificate the day you pass.",
  "price_cents": 0,
  "currency": "cad",
  "duration_minutes": 300,
  "language": "English",
  "pass_mark": 70,
  "exam_question_count": 30,
  "exam_time_limit_minutes": 60,
  "max_attempts": 3,
  "attempt_cooldown_minutes": 30,
  "max_focus_violations": 3,
  "require_fullscreen": true,
  "certificate_validity_months": 60,
  "highlights": [
    "10 chapters with video lessons",
    "A short quiz after every module",
    "Proctored final exam (3 attempts)",
    "PDF certificate with QR verification",
    "Study on any device, at your own pace"
  ],
  "outcomes": [
    "Explain how foodborne illness happens and who is most at risk",
    "Keep food out of the temperature danger zone (4°C to 60°C)",
    "Cook, cool, reheat and hot-hold food to safe temperatures",
    "Wash hands correctly and know when you must not work",
    "Prevent cross-contamination during storage and preparation",
    "Identify Canada’s priority food allergens and prevent cross-contact",
    "Clean and sanitize surfaces and dishes at the right concentration",
    "Spot pest activity and apply the basics of HACCP"
  ],
  "description_md": `## Who this course is for

Anyone who prepares, serves or handles food at work: cooks, servers, baristas, dishwashers, caterers, grocery and deli staff, daycare and long-term-care kitchen staff, food truck operators and owners.

## How it's structured

Ten modules build from the basics of foodborne illness to the systems a food business uses to stay safe. Each module is one chapter — a video and a written lesson — followed by a short quiz. Modules unlock in order. When you finish the last quiz, the proctored final exam opens.

> Food safety rules vary by province and municipality. This course teaches the standards that apply across Canada and uses Ontario's Food Premises Regulation as its reference point. Always follow your local public health unit's requirements.`,
  "faqs": [
    {
      "q": "How long does the course take?",
      "a": "About five hours, including the videos and module quizzes. You can stop at any point and pick up where you left off on any device."
    },
    {
      "q": "What do I need to pass?",
      "a": "Complete all 10 chapters and module quizzes, then score at least 70% on the proctored final exam: 30 multiple-choice questions in 60 minutes. Your enrolment includes three exam attempts."
    },
    {
      "q": "When do I get my certificate?",
      "a": "After you pass, our team reviews your ID check and exam recording. Your certificate is issued when that review is complete, and you can download it from your dashboard: a PDF with your name, a unique certificate number and a QR code."
    },
    {
      "q": "How can my employer check my certificate?",
      "a": "They can scan the QR code or enter the certificate number on our verification page. It shows whether the certificate is valid, expired or revoked."
    },
    {
      "q": "How long is the certificate valid?",
      "a": "Five years from the date it is issued. The expiry date is printed on the certificate and shown on the verification page."
    },
    {
      "q": "Is this course accepted where I work?",
      "a": "Requirements differ by province and by public health unit. If you need certification for a specific job or inspection, check with your employer or local public health unit before you enrol."
    },
    {
      "q": "What happens if I fail the exam?",
      "a": "You will see your score and which topics to review. After a short break you can try again, up to three attempts in total."
    },
    {
      "q": "How do the module quizzes work?",
      "a": "Each module ends with a short quiz. Answer each question correctly to move to the next one, and finish the quiz to unlock the next module. Quizzes are not timed or monitored."
    },
    {
      "q": "What do I need for the final exam?",
      "a": "A laptop or desktop computer with a webcam and microphone, Google Chrome or Microsoft Edge, one screen, a quiet private room, and government-issued photo ID. Before the exam starts you will photograph your ID and show your room on camera. The camera stays on for the whole exam."
    },
    {
      "q": "Why is the final exam proctored?",
      "a": "So every certificate means something. Your ID, room scan and exam recording are reviewed before your certificate is issued. Phones and other devices must be out of reach, and no one else may be in the room."
    }
  ]
};

export const modules = [
  {
    title: "Food safety foundations",
    lessons: [
      {
        title: "Food safety foundations",
        video_url: null,
        min_seconds: 480,
        content_md: `Every year, about **1 in 8 Canadians — roughly 4 million people — get sick from food** contaminated in Canada, according to the Public Health Agency of Canada. Most cases are preventable by the people who handle food.

## What is foodborne illness?

Foodborne illness ("food poisoning") is any illness caused by eating food or drinking beverages contaminated with harmful microorganisms, their toxins, chemicals, or physical objects. Symptoms usually include nausea, vomiting, diarrhea, stomach cramps and fever. They can appear within an hour or take several weeks.

## Who is most at risk?

Some people are far more likely to become seriously ill:

- **Young children**, whose immune systems are still developing
- **Older adults**
- **Pregnant people** and their unborn babies
- **People with weakened immune systems** (for example, from cancer treatment, diabetes, HIV or transplants)

When you serve these groups — in daycares, hospitals, long-term care homes — food safety mistakes can be life-threatening.

## Your responsibilities

- **Food handlers** must follow safe practices every shift: personal hygiene, temperature control, preventing contamination, cleaning and sanitizing.
- **Owners and operators** must provide the facilities, equipment, training and supervision that make safe food possible.
- **Public health inspectors** enforce provincial food premises regulations. They can issue orders, lay charges and close a premises that poses a health hazard.

> The cost of an outbreak goes beyond sick customers: closures, fines, lawsuits and a damaged reputation can end a business.

## The four types of food hazards

A **hazard** is anything in food that can cause harm. There are four kinds.

## 1. Biological hazards

Living organisms and the toxins they produce: **bacteria, viruses, parasites and fungi (moulds and some yeasts)**. These cause most foodborne illness. You can't see, smell or taste most of them — food can look and smell perfectly normal and still make people sick.

## 2. Chemical hazards

Cleaning products, sanitizers, pesticides, pest-control products, lubricants, and metals that leach into acidic food from unsuitable containers. Prevent them by:

- Storing chemicals **below and away from** food, in labelled original containers
- Following label directions for concentration
- Never reusing chemical containers for food

## 3. Physical hazards

Foreign objects such as glass, metal shavings, staples, bandages, jewellery, hair, fingernails and bone fragments. Prevent them by maintaining equipment, wearing hair restraints, removing jewellery and inspecting food.

## 4. Allergens

Proteins in certain foods that trigger a dangerous immune reaction in some people. Allergens are covered in detail in Module 5.`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["About how many people in Canada get sick each year from food contaminated in Canada?",["About 40,000","About 400,000","About 4 million","About 40 million"],2,"The Public Health Agency of Canada estimates about 1 in 8 Canadians — roughly 4 million people — each year."],
      ["Which of these is a biological hazard?",["Norovirus","Bleach residue","A metal shaving","A plastic bandage"],0,"Biological hazards are living organisms such as bacteria, viruses and parasites, and the toxins they make."],
      ["Who enforces provincial food premises regulations?",["Restaurant owners","Public health inspectors","Food suppliers","Customers"],1,"Public health inspectors can issue orders, lay charges and close a premises that poses a health hazard."],
      ["Can food that looks and smells normal still make someone sick?",["No — unsafe food always smells bad","Yes — most harmful microorganisms can’t be seen, smelled or tasted","Only if it is past its best-before date","Only if it is raw"],1,"You can’t rely on your senses. Safe practices are what keep food safe."],
    ],
  },
  {
    title: "Microorganisms and foodborne illness",
    lessons: [
      {
        title: "Microorganisms and foodborne illness",
        video_url: null,
        min_seconds: 540,
        content_md: `## Bacteria

Bacteria are single-celled organisms found everywhere. Under the right conditions, many can **double every 20 minutes** — one bacterium can become millions in a few hours. Some bacteria also produce **toxins** that are **not destroyed by cooking or reheating**.

Some bacteria form **spores**, a protective shell that survives cooking. When food cools slowly, spores "wake up" and multiply. This is why cooling food quickly matters.

## Common foodborne bacteria

| Bacterium | Commonly linked to |
|---|---|
| *Salmonella* | Raw poultry, eggs, unpasteurized dairy, produce |
| *E. coli* O157:H7 | Undercooked ground beef, unpasteurized juice, leafy greens |
| *Listeria monocytogenes* | Deli meats, soft cheeses, smoked seafood; grows at fridge temperatures |
| *Clostridium perfringens* | Large batches of meat, stews and gravies cooled too slowly |
| *Staphylococcus aureus* | Spread from hands, cuts and noses; produces heat-stable toxins |
| *Bacillus cereus* | Cooked rice and starches left at room temperature |
| *Campylobacter* | Raw and undercooked poultry |

## Viruses

Viruses don't grow in food, but a tiny amount can make someone sick. They spread mainly from **infected food handlers** through poor handwashing. **Norovirus** and **hepatitis A** are the most common. Cooking doesn't help if a sick worker contaminates ready-to-eat food after cooking.

## Parasites

Parasites live in or on a host. Examples include *Trichinella* (pork, wild game), *Anisakis* (fish) and *Giardia* (contaminated water). Proper cooking or freezing controls most of them.

## What bacteria need to grow (FAT TOM)

Bacteria need six conditions to grow. Remember them as **FAT TOM**:

- **F**ood — especially foods high in protein or carbohydrates
- **A**cidity — bacteria prefer low-acid foods (pH above 4.6)
- **T**ime — given enough time, bacteria multiply to dangerous levels
- **T**emperature — they grow fastest between **4°C and 60°C**, the **danger zone**
- **O**xygen — some need it, some don't, some grow either way
- **M**oisture — they need water to grow

As a food handler, the two conditions you control most directly are **time and temperature**.

## High-risk foods

Foods that support rapid bacterial growth are called **high-risk** or **potentially hazardous foods**. They need temperature control:

- Meat, poultry, fish and seafood
- Eggs and egg products
- Milk and dairy products
- Cooked rice, pasta, beans and potatoes
- Cut melons, cut leafy greens and sprouts
- Cooked vegetables, tofu and soy products
- Sauces, gravies, soups and casseroles

Dry foods (crackers, uncooked pasta, flour), high-acid foods and high-sugar foods are lower risk because they lack moisture or are too acidic.`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["What does the “M” in FAT TOM stand for?",["Meat","Moisture","Microbes","Mould"],1,"Food, Acidity, Time, Temperature, Oxygen, Moisture."],
      ["Under ideal conditions, many bacteria can double about every:",["20 minutes","2 hours","12 hours","2 days"],0,"That is why a few bacteria can become millions within hours."],
      ["Why does cooling cooked food quickly matter for bacteria such as Clostridium perfringens?",["Their spores survive cooking and multiply if food cools slowly","Cooling kills their spores","They only grow in the freezer","It doesn’t matter for these bacteria"],0,"Spores survive cooking. Fast cooling stops them from multiplying."],
      ["Which food is lower risk because it lacks moisture?",["Cooked rice","Cut melon","Uncooked dry pasta","Sliced deli meat"],2,"Bacteria need moisture to grow. Dry foods are lower risk."],
    ],
  },
  {
    title: "Handwashing and glove use",
    lessons: [
      {
        title: "Handwashing and glove use",
        video_url: null,
        min_seconds: 240,
        content_md: `Hands are the most common way germs get into food. Correct handwashing is the single most important habit a food handler has.

## How to wash your hands

1. Wet hands with warm running water
2. Apply soap
3. Scrub all surfaces — backs of hands, between fingers, under nails, wrists — for **at least 20 seconds**
4. Rinse thoroughly under running water
5. Dry with a **single-use paper towel**
6. Use the paper towel to turn off the tap

Wash only in a **designated handwashing sink**, never in a food-prep or dishwashing sink. Hand sanitizer **does not replace** handwashing in a food premises.

## When to wash your hands

- When you start work and when you return from a break
- After using the washroom
- **Before** handling ready-to-eat food and **after** handling raw meat, poultry, fish or eggs
- After touching your face, hair, phone or money
- After coughing, sneezing or blowing your nose
- After handling garbage, dirty dishes or chemicals
- After cleaning
- Before putting on gloves and when changing tasks

## Gloves

Gloves help — but only when used correctly. **Wash your hands before putting gloves on.** Change gloves when they tear, when they become dirty, when you change tasks, after handling raw food, and at least every four hours of continuous use. Never wash or reuse single-use gloves.`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["What is the last step of correct handwashing?",["Dry your hands on your apron","Use the paper towel to turn off the tap","Shake your hands dry","Apply hand sanitizer instead of drying"],1,"Turning off the tap with the paper towel keeps your clean hands clean."],
      ["Can hand sanitizer replace handwashing in a food premises?",["Yes, always","Yes, if your hands look clean","No — it does not replace handwashing","Only after using the washroom"],2,"Sanitizer is not a substitute for soap, water and scrubbing."],
      ["When must you change single-use gloves? (Select all that apply)",["When they tear","When you change tasks","After handling raw meat","Only at the end of the shift"],[0,1,2],"Also change them when they get dirty, and at least every four hours of continuous use."],
      ["You touched your phone and are about to plate a salad. What do you do first?",["Put on gloves","Wash your hands","Wipe your hands on a towel","Nothing — phones are clean"],1,"Wash your hands after touching your phone, then put on gloves if you use them."],
    ],
  },
  {
    title: "Illness, injuries and work attire",
    lessons: [
      {
        title: "Illness, injuries and work attire",
        video_url: null,
        min_seconds: 240,
        content_md: `## Don't work sick

You must tell your supervisor and **must not handle food** if you have:

- Vomiting or diarrhea
- Jaundice (yellowing of the skin or eyes)
- A fever with a sore throat
- An infected cut, burn or sore on your hands or arms that can't be covered

A common public health rule is to stay away from food handling until you have been **symptom-free for 48 hours** after vomiting or diarrhea. If you are diagnosed with an illness such as hepatitis A, norovirus, *Salmonella* or *E. coli* infection, follow your public health unit's direction before returning.

## Cuts and burns

Clean the wound, cover it with a **brightly coloured waterproof bandage**, and wear a single-use glove over bandages on hands. Bright colours make a bandage easy to spot if it falls into food.

## Work attire and habits

- Wear clean clothes or a clean uniform and apron
- Keep hair tied back and wear a **hair restraint** (hat or hairnet); restrain beards
- Remove jewellery from hands and wrists (a plain band may be allowed by your workplace)
- Keep fingernails short and clean; no nail polish or false nails when handling food
- Don't eat, drink, smoke, vape or chew gum in food preparation areas
- Taste food with a clean utensil each time — never with your fingers or the stirring spoon`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["Which symptom means you must not handle food?",["A mild headache","Vomiting","Tired eyes","A sore back"],1,"Vomiting, diarrhea, jaundice, or a fever with a sore throat must be reported. Do not handle food."],
      ["Why should bandages used in a kitchen be brightly coloured?",["To match the uniform","So they’re easy to spot if they fall into food","They heal wounds faster","Regulations require blue"],1,"A bright, waterproof bandage under a glove is easy to find if it comes off."],
      ["A common rule: after vomiting or diarrhea, return to handling food only once you’ve been symptom-free for at least:",["2 hours","12 hours","48 hours","2 weeks"],2,"Follow your public health unit if you’ve been diagnosed with a specific illness."],
      ["How should a cook taste a sauce?",["With a clean utensil each time","With a finger","With the stirring spoon","Straight from the ladle"],0,"Use a clean utensil for every taste."],
    ],
  },
  {
    title: "The danger zone and safe cooking",
    lessons: [
      {
        title: "The danger zone and safe cooking",
        video_url: null,
        min_seconds: 300,
        content_md: `## The temperature danger zone

Bacteria multiply fastest between **4°C and 60°C (40°F to 140°F)**. Keep high-risk food out of this range.

- Keep **cold food at 4°C or colder**
- Keep **frozen food at −18°C or colder**
- Keep **hot food at 60°C or hotter**
- Limit time in the danger zone — a common rule is **no more than 2 hours in total**

## Safe internal cooking temperatures

Cooking to the right **internal** temperature kills harmful bacteria. These are Health Canada's recommended minimums:

| Food | Minimum internal temperature |
|---|---|
| Whole poultry (chicken, turkey, duck) | **82°C** |
| Poultry pieces and ground poultry | **74°C** |
| Ground meat (beef, pork, veal, lamb) | **71°C** |
| Pork (pieces and whole cuts) | **71°C** |
| Beef, veal, lamb (whole cuts) | 63°C (medium-rare) · 71°C (medium) · 77°C (well done) |
| Fish | **70°C** |
| Egg dishes | **74°C** |
| Leftovers, stuffing, hot dogs, casseroles | **74°C** |

Colour is not a reliable test. Ground beef can turn brown before it is safe. **Always use a probe thermometer.**

## Using a thermometer

- Insert the probe into the **thickest part** of the food, away from bone, fat or gristle
- Clean and sanitize the probe between foods
- **Calibrate** regularly: in ice water a thermometer should read **0°C**`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["What is the minimum safe internal temperature for fish?",["63°C","70°C","74°C","82°C"],1,"Health Canada recommends 70°C for fish."],
      ["Ground poultry must reach at least:",["63°C","71°C","74°C","82°C"],2,"Poultry pieces and ground poultry: 74°C. Whole poultry: 82°C."],
      ["Is colour a reliable way to tell whether ground beef is cooked?",["Yes — brown means safe","No — use a probe thermometer","Yes — if the juices run clear","Only for thick patties"],1,"Ground beef can turn brown before it is safe. Always measure."],
      ["A common rule limits high-risk food’s total time in the danger zone to no more than:",["30 minutes","2 hours","6 hours","12 hours"],1,"Keep high-risk food out of 4°C–60°C, and keep total time in that range short."],
    ],
  },
  {
    title: "Cooling, reheating, holding and thawing",
    lessons: [
      {
        title: "Cooling, reheating, holding and thawing",
        video_url: null,
        min_seconds: 300,
        content_md: `## Cooling cooked food

Slow cooling is a leading cause of outbreaks. Spore-forming bacteria such as *Clostridium perfringens* multiply in large batches that sit warm for hours.

Use **two-stage cooling**:

1. From **60°C to 20°C within 2 hours**
2. Then from **20°C to 4°C within the next 4 hours**

Ways to cool faster:

- Divide large batches into **shallow pans** (5–8 cm deep)
- Cut large roasts into smaller pieces
- Use an **ice bath** or ice wand, and stir often
- Use a blast chiller if available
- Leave containers **uncovered or loosely covered** in the fridge until cold, with space for air to circulate

Never cool food at room temperature on the counter.

## Reheating

Reheat cooked food that will be hot-held to an internal temperature of **74°C**, quickly. Don't use steam tables or hot-holding units to reheat — they aren't designed to heat food fast enough.

## Hot and cold holding

- Hot holding: keep food at **60°C or hotter**
- Cold holding: keep food at **4°C or colder**
- Check and record holding temperatures at least every few hours, and stir hot food to keep the temperature even

## Thawing safely

Never thaw frozen food on the counter. Safe methods are:

1. In the **refrigerator** (plan ahead — this is the best method)
2. Under **cold running water**, fully submerged in its packaging
3. In the **microwave**, if the food will be cooked immediately
4. As part of the **cooking process** (for example, frozen burgers cooked from frozen)`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["Which equipment should NOT be used to reheat food?",["A stove","An oven","A microwave","A steam table"],3,"Hot-holding equipment can’t heat food fast enough. Reheat quickly to 74°C, then hot-hold."],
      ["When cooling food in the fridge, containers should be:",["Sealed tight and stacked","Uncovered or loosely covered, with space for air to circulate","Wrapped in towels","Kept on the floor"],1,"Air must circulate to pull heat out of the food."],
      ["Thawing in the microwave is safe if the food is:",["Cooked immediately afterwards","Left on the counter to finish thawing","Refrozen afterwards","Stored overnight first"],0,"Microwave-thawed food may be partly warm. Cook it right away."],
      ["About how deep should shallow pans for cooling be?",["5–8 cm","15–20 cm","30 cm","Depth doesn’t matter"],0,"Shallow food cools much faster than a deep pot."],
    ],
  },
  {
    title: "Receiving, storage and cross-contamination",
    lessons: [
      {
        title: "Receiving, storage and cross-contamination",
        video_url: null,
        min_seconds: 540,
        content_md: `## Receiving deliveries

Food safety starts at the back door. Buy only from **approved, inspected sources**. When a delivery arrives:

- Check refrigerated food is **4°C or colder** and frozen food is **frozen solid** (−18°C or colder)
- **Reject** frozen food with large ice crystals or fluid stains — signs it thawed and refroze
- Reject damaged, swollen, leaking or dented cans and torn packaging
- Check best-before and expiry dates
- Look for signs of pests
- Put away cold and frozen items **first**, immediately

## Storage

- Label and date all prepared and opened food
- Use **FIFO — First In, First Out**: older stock at the front, used first
- Store food **at least 15 cm (6 inches) off the floor** and away from walls
- Keep dry storage cool, dry and well ventilated
- Never store food in washrooms, change rooms, or near chemicals
- Don't overload fridges — cold air must circulate
- Keep a thermometer in every fridge and freezer and **log temperatures**

## Cross-contamination

**Cross-contamination** is the transfer of harmful microorganisms from one food, surface or person to another — most often from raw foods to ready-to-eat foods.

## Common ways it happens

- Raw meat juices dripping onto foods below in the fridge
- Using the same cutting board or knife for raw chicken and salad
- Touching ready-to-eat food after handling raw meat without washing your hands
- Wiping surfaces with a dirty cloth

## Refrigerator storage order

Store **ready-to-eat foods on top** and raw foods below, in order of the temperature they must be cooked to — the highest cooking temperature goes at the bottom:

1. **Top:** ready-to-eat foods (cooked dishes, salads, dairy, desserts)
2. Whole fish and seafood (70°C)
3. Whole cuts of beef and pork (63–71°C)
4. Ground meats (71°C)
5. **Bottom:** poultry — whole, pieces and ground (74–82°C)

## Preparation habits that prevent it

- Use separate (colour-coded) cutting boards and utensils for raw and ready-to-eat foods
- Clean and **sanitize** surfaces and equipment between tasks
- Prepare raw meat and ready-to-eat food at different times or in different areas
- Wash produce under running water before cutting
- Use tongs, deli paper or gloves — not bare hands — for ready-to-eat food`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["Refrigerated deliveries should arrive at what temperature?",["4°C or colder","10°C or colder","Room temperature","60°C or hotter"],0,"Check with a thermometer when you receive the delivery."],
      ["Which canned goods should you reject?",["Swollen or leaking cans","Cans with paper labels","Cans packed in boxes","Cans showing a best-before date"],0,"Reject swollen, leaking, badly dented or rusted cans."],
      ["Whole fish, raw ground beef and raw chicken share a fridge. Which goes on the lowest shelf?",["Whole fish","Raw ground beef","Raw chicken","It doesn’t matter"],2,"The food with the highest cooking temperature goes lowest. Poultry is cooked to 74–82°C."],
      ["Which of these is cross-contamination?",["Using the same knife for raw chicken and then lettuce","Cooking chicken to 74°C","Storing salad above raw meat","Washing your hands between tasks"],0,"Germs from the raw chicken transfer to the ready-to-eat lettuce."],
    ],
  },
  {
    title: "Food allergens",
    lessons: [
      {
        title: "Food allergens",
        video_url: null,
        min_seconds: 300,
        content_md: `A food allergy is an immune-system reaction to a specific protein. A severe reaction — **anaphylaxis** — can cause swelling of the throat, difficulty breathing, a drop in blood pressure and death within minutes. **Cooking does not destroy allergens.**

## Canada's priority food allergens

Health Canada identifies these priority allergens:

- Peanuts
- Tree nuts (such as almonds, cashews, walnuts)
- Sesame seeds
- Milk
- Eggs
- Fish
- Crustaceans and molluscs (shellfish such as shrimp, lobster, clams)
- Soy
- Wheat and triticale
- Mustard
- Sulphites (a food additive that can trigger reactions)

## Preventing allergen cross-contact

**Cross-contact** happens when an allergen gets into a food that shouldn't contain it — for example, using the same fryer oil for shrimp and fries, or the same knife for peanut butter and a sandwich.

- Know the ingredients in every dish and keep recipes and labels on hand
- When a customer tells you about an allergy, **take it seriously** and tell the kitchen
- Wash hands and change gloves before preparing an allergy order
- Use **clean, sanitized** equipment and surfaces, or dedicated allergen-free equipment
- Never just scrape off an allergen (removing nuts from a dessert doesn't make it safe)
- If you're not sure a dish is safe, **say so**. Never guess.

If a customer has a reaction, **call 911**. If they carry an epinephrine auto-injector, help them use it.`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["What is anaphylaxis?",["A mild rash","A severe, possibly life-threatening allergic reaction","Food poisoning from bacteria","An intolerance to lactose"],1,"It can cause throat swelling, trouble breathing and a drop in blood pressure within minutes."],
      ["Using the same fryer oil for shrimp and for fries can cause:",["Allergen cross-contact","Better flavour","Pest problems","Nothing — frying destroys allergens"],0,"Shellfish protein gets into the oil and onto the fries. Cooking does not destroy allergens."],
      ["Which of these is a priority food allergen in Canada?",["Mustard","Chicken","Rice","Apples"],0,"Health Canada’s list includes mustard, sesame, peanuts, tree nuts, milk, eggs, fish, shellfish, soy, wheat and sulphites."],
      ["A guest with a nut allergy starts reacting at the table. What do you do first?",["Call 911, and help them use their epinephrine auto-injector if they carry one","Give them water and wait","Ask them to leave","Offer an antacid"],0,"Anaphylaxis is an emergency. Get help immediately."],
    ],
  },
  {
    title: "Cleaning and sanitizing",
    lessons: [
      {
        title: "Cleaning and sanitizing",
        video_url: null,
        min_seconds: 300,
        content_md: `**Cleaning** removes visible dirt, food and grease. **Sanitizing** reduces harmful microorganisms to safe levels. Surfaces must be **cleaned first** — sanitizer can't work through food residue.

Food-contact surfaces (cutting boards, knives, counters, slicers) must be cleaned and sanitized:

- After each use
- When you switch from raw to ready-to-eat food
- When you're interrupted during a task
- At least every 4 hours if in continuous use

## Manual dishwashing: the three-compartment sink

1. **Wash** in hot water with detergent
2. **Rinse** in clean water to remove detergent
3. **Sanitize** using one of the methods below, for at least **45 seconds**
4. **Air dry** — never towel dry, which can recontaminate dishes

## Sanitizer concentrations

Ontario's Food Premises Regulation sets these standards for manual dishwashing:

| Sanitizer | Concentration | Contact time |
|---|---|---|
| Chlorine | **100 ppm** | 45 seconds |
| Quaternary ammonium ("quats") | **200 ppm** | 45 seconds |
| Iodine | **25 ppm** | 45 seconds |
| Hot water | **77°C or hotter** | 45 seconds |

Always follow the manufacturer's label, and **check concentration with test strips**. Too weak won't kill germs; too strong can leave a toxic residue.

## Chemical safety

- Store chemicals in labelled containers, **below and away from food**
- Never mix chemicals (bleach and ammonia produce toxic gas)
- Know where to find the **Safety Data Sheets (SDS)** — WHMIS training applies to food workplaces`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["Why must a surface be cleaned before it is sanitized?",["Sanitizer can’t work through food residue","Cleaning is optional","Sanitizer removes grease","To use less water"],0,"Clean first, then sanitize."],
      ["How should dishes dry after sanitizing?",["Towel dry","Air dry","Wipe them with an apron","Stack them wet"],1,"Towels can recontaminate clean dishes."],
      ["What happens if you mix bleach and ammonia?",["You get a stronger sanitizer","It produces toxic gas","It’s required for floors","Nothing, in small amounts"],1,"Never mix chemicals."],
      ["Food-contact surfaces in continuous use should be cleaned and sanitized at least every:",["30 minutes","4 hours","12 hours","Once a day"],1,"Also clean and sanitize after each use, between raw and ready-to-eat foods, and after interruptions."],
    ],
  },
  {
    title: "Pest control and food safety systems",
    lessons: [
      {
        title: "Pest control and food safety systems",
        video_url: null,
        min_seconds: 540,
        content_md: `Cockroaches, mice, rats and flies spread disease-causing bacteria and contaminate food with droppings, hair and urine. A pest infestation is grounds for an inspector to close a premises.

## Signs of pests

- Droppings, gnaw marks, nests or shredded paper
- Live or dead insects, egg cases, shed skins
- Grease marks along walls (rodent trails)
- Unusual odours

## Prevention

1. **Deny entry** — seal cracks and gaps, keep doors closed, use screens and door sweeps, inspect deliveries
2. **Deny food and shelter** — store food in sealed containers off the floor, clean up spills immediately, remove garbage regularly in covered bins, eliminate clutter
3. **Work with a licensed pest control operator** for treatment. Never apply pesticides yourself near food.

If you see signs of pests, **report them to your supervisor immediately**.

## HACCP and daily food safety routines

**HACCP (Hazard Analysis Critical Control Point)** is a preventive system used around the world to control food safety hazards before they reach the customer.

## The seven HACCP principles

1. **Conduct a hazard analysis** — identify biological, chemical and physical hazards at each step
2. **Determine critical control points (CCPs)** — steps where a hazard can be prevented, eliminated or reduced (for example, cooking or cooling)
3. **Establish critical limits** — measurable limits for each CCP (for example, cook chicken to 74°C)
4. **Establish monitoring procedures** — how and how often you'll check (for example, probe each batch)
5. **Establish corrective actions** — what to do when a limit isn't met (for example, keep cooking; discard food cooled too slowly)
6. **Establish verification procedures** — confirm the system works (for example, review logs, calibrate thermometers)
7. **Establish record-keeping** — keep logs of temperatures, corrective actions and training

## Daily habits that put HACCP into practice

- Log fridge, freezer and hot-holding temperatures
- Probe and record cooking and cooling temperatures
- Check sanitizer concentration with test strips
- Label and date prepared food; discard anything past its date
- Report problems — broken equipment, pests, illness — right away

> **When in doubt, throw it out.** No dish is worth making someone sick.

This is the last chapter. Complete it and the Module 10 quiz to unlock the final exam.`,
      },
    ],
    // [prompt, options, correct index (or array for multi), explanation]
    quiz: [
      ["Who should apply pesticides in a food premises?",["Any staff member","A licensed pest control operator","The cook on duty","The delivery driver"],1,"Never apply pesticides yourself near food."],
      ["Which of these helps keep pests out?",["Sealing cracks and keeping doors closed","Leaving garbage uncovered","Storing food on the floor","Propping doors open"],0,"Deny pests entry, food and shelter."],
      ["What does HACCP stand for?",["Health and Cleaning Control Plan","Hazard Analysis Critical Control Point","High Accuracy Cooking Check Process","Hygiene and Contamination Control Policy"],1,"A preventive system for controlling food safety hazards."],
      ["Checking and logging fridge temperatures every day is an example of:",["Monitoring","Hazard analysis","Pest control","Allergen management"],0,"Monitoring confirms critical limits are being met."],
    ],
  },
];

// Final-exam bank: [prompt, options[], correct index (or array for multi), module index, explanation]
export const questions = [
  ["What is the temperature danger zone?",["0°C to 60°C","4°C to 60°C","10°C to 50°C","4°C to 74°C"],1,4,"Bacteria grow fastest between 4°C and 60°C."],
  ["What is the minimum safe internal cooking temperature for a whole chicken?",["71°C","74°C","77°C","82°C"],3,4,"Whole poultry must reach 82°C."],
  ["What is the minimum safe internal cooking temperature for ground beef?",["63°C","68°C","71°C","82°C"],2,4,"Ground meat must reach 71°C."],
  ["Leftovers that will be hot-held should be reheated to what internal temperature?",["60°C","65°C","71°C","74°C"],3,5,"Reheat to 74°C quickly."],
  ["Hot food being held for service must be kept at what temperature?",["50°C or hotter","55°C or hotter","60°C or hotter","74°C or hotter"],2,5,"Hot-hold at 60°C or above."],
  ["Refrigerated food should be kept at what temperature?",["4°C or colder","7°C or colder","10°C or colder","0°C exactly"],0,4,"Cold-hold at 4°C or below."],
  ["Frozen food should be stored at what temperature?",["0°C or colder","−5°C or colder","−10°C or colder","−18°C or colder"],3,4,""],
  ["Using two-stage cooling, cooked food must cool from 60°C to 20°C within:",["1 hour","2 hours","4 hours","6 hours"],1,5,"Then 20°C to 4°C within the next 4 hours."],
  ["After reaching 20°C, cooked food must cool to 4°C within the next:",["1 hour","2 hours","4 hours","8 hours"],2,5,""],
  ["Which is a SAFE way to thaw frozen meat?",["On the counter overnight","In warm water","In the refrigerator","In a hot-holding cabinet"],2,5,""],
  ["Where should you insert a probe thermometer to check a roast?",["Into the surface","Into the thickest part, away from bone","Next to the bone","Into the juices in the pan"],1,4,""],
  ["What should a properly calibrated thermometer read in ice water?",["−4°C","0°C","4°C","10°C"],1,4,""],
  ["What is the best way to cool a large pot of soup?",["Leave it on the stove to cool overnight","Put the full pot straight into the freezer","Divide it into shallow pans and use an ice bath","Cover tightly and leave on the counter"],2,5,""],
  ["For how long should you scrub your hands with soap when handwashing?",["5 seconds","10 seconds","At least 20 seconds","2 minutes"],2,2,""],
  ["Where may food handlers wash their hands?",["Any sink in the kitchen","A designated handwashing sink","The food preparation sink","The three-compartment dishwashing sink"],1,2,""],
  ["Which of these must you do BEFORE putting on single-use gloves?",["Nothing — gloves replace handwashing","Use hand sanitizer only","Wash your hands","Rinse your hands in the prep sink"],2,2,""],
  ["A cook has had diarrhea since last night. What should they do?",["Work, but wear gloves","Work only at the dish station","Report it to the supervisor and not handle food","Take medication and work as normal"],2,3,""],
  ["How should a small cut on a food handler’s finger be handled?",["Leave it uncovered so it can heal","Cover it with a brightly coloured waterproof bandage and a glove","Wrap it in a paper towel","Cover it with tape"],1,3,""],
  ["Which of the following are good personal hygiene practices? (Select all that apply)",["Wearing a hair restraint","Keeping fingernails short and clean","Tasting food with your fingers","Removing hand and wrist jewellery"],[0,1,3],3,""],
  ["What does the \"T\" for Temperature in FAT TOM tell us?",["Bacteria grow best in the danger zone","Bacteria only grow when frozen","Bacteria are killed at 20°C","Temperature does not affect bacteria"],0,1,""],
  ["Which of these is a high-risk (potentially hazardous) food?",["Uncooked dry pasta","Cooked rice","Crackers","Granulated sugar"],1,1,""],
  ["Why can reheating NOT make food that was stored badly safe again?",["Reheating adds bacteria","Some bacteria produce toxins that heat does not destroy","Reheated food always tastes bad","Bacteria only grow after reheating"],1,1,""],
  ["Norovirus and hepatitis A are most often spread to food by:",["Undercooked poultry","Infected food handlers with poor handwashing","Dented cans","Dry storage areas"],1,1,""],
  ["Which bacterium can grow at refrigerator temperatures and is linked to deli meats and soft cheeses?",["Listeria monocytogenes","Clostridium perfringens","Bacillus cereus","Campylobacter"],0,1,""],
  ["Which group is at HIGHER risk of serious foodborne illness?",["Healthy adults aged 25–40","Pregnant people, young children and older adults","Professional athletes","Restaurant staff"],1,0,""],
  ["Which is an example of a physical hazard?",["Salmonella","A piece of broken glass","Bleach residue","Peanut protein"],1,0,""],
  ["Which is an example of a chemical hazard?",["Hair","Norovirus","Sanitizer stored above food","A bone fragment"],2,0,""],
  ["In a refrigerator, which food should be stored on the BOTTOM shelf?",["Ready-to-eat salads","Whole fish","Raw poultry","Dairy products"],2,6,"Foods with the highest cooking temperature go lowest."],
  ["In a refrigerator, which food belongs on the TOP shelf?",["Raw ground beef","Ready-to-eat foods","Raw chicken","Raw pork"],1,6,""],
  ["What is cross-contamination?",["Cooking food to the wrong temperature","The transfer of harmful microorganisms from one food or surface to another","Mixing two sanitizers","Storing food past its best-before date"],1,6,""],
  ["Which practice helps prevent cross-contamination?",["Using one cutting board for everything","Using separate, colour-coded boards for raw meat and produce","Wiping boards with a dry cloth between uses","Storing raw chicken above salads"],1,6,""],
  ["Which of these are among Health Canada’s priority food allergens? (Select all that apply)",["Sesame seeds","Mustard","Rice","Shellfish (crustaceans and molluscs)"],[0,1,3],7,""],
  ["A customer says they have a severe peanut allergy. What is the right response?",["Pick any peanuts off the dish before serving","Tell them the dish is probably fine","Inform the kitchen and follow allergen procedures; say so if you are not sure a dish is safe","Suggest they bring their own food next time"],2,7,""],
  ["Does cooking destroy food allergens?",["Yes, at 74°C","Yes, at 100°C","No","Only in the microwave"],2,7,""],
  ["What is the correct order for manual dishwashing in a three-compartment sink?",["Rinse, wash, sanitize, towel dry","Wash, rinse, sanitize, air dry","Sanitize, wash, rinse, air dry","Wash, sanitize, rinse, towel dry"],1,8,""],
  ["What chlorine concentration is used to sanitize dishes manually?",["10 ppm","50 ppm","100 ppm","500 ppm"],2,8,""],
  ["If using hot water to sanitize dishes, the water must be at least:",["60°C","71°C","77°C","100°C"],2,8,""],
  ["What is the difference between cleaning and sanitizing?",["There is no difference","Cleaning removes dirt; sanitizing reduces microorganisms to safe levels","Sanitizing removes dirt; cleaning kills germs","Cleaning is only needed once a day"],1,8,""],
  ["How should you check that a sanitizer solution is the right strength?",["By smell","By colour","With sanitizer test strips","By how slippery it feels"],2,8,""],
  ["Which is a sign of a rodent problem?",["Droppings and gnaw marks","Condensation on pipes","A full garbage bin","Frost in the freezer"],0,9,""],
  ["What does FIFO stand for in food storage?",["Fast In, Fast Out","First In, First Out","Freeze It, Free Off","Fresh Is For Ordering"],1,6,""],
  ["Food stored in a walk-in cooler or dry storage room should be kept at least how far off the floor?",["2 cm","5 cm","15 cm","It can be stored on the floor"],2,6,""],
  ["A delivery of frozen fish has large ice crystals and fluid stains on the box. You should:",["Accept it and use it first","Refreeze it immediately","Reject it — it may have thawed and refrozen","Accept it if the driver signs"],2,6,""],
  ["In HACCP, what is a critical control point?",["Any point where food is stored","A step where a hazard can be prevented, eliminated or reduced to a safe level","The cash register","The point where the customer receives food"],1,9,""],
  ["Cooking chicken to 74°C is an example of which HACCP principle?",["A critical limit","Record keeping","Verification","Hazard analysis"],0,9,""],
  ["A batch of chili took 5 hours to cool from 60°C to 20°C. What is the correct corrective action?",["Put it in the freezer to finish cooling","Reheat it and serve it","Discard it","Serve it cold"],2,9,"It missed the 2-hour limit for the first cooling stage."],
];
