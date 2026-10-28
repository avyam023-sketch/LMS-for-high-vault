# Social ads

| File | Size | Use |
|---|---|---|
| `ad-feed-1080x1350.png` | 1080 × 1350 (4:5) | Instagram and Facebook feed. The best-performing feed size. |
| `ad-square-1080x1080.png` | 1080 × 1080 (1:1) | Feed, LinkedIn, Google display. |
| `ad-story-1080x1920.png` | 1080 × 1920 (9:16) | Instagram and Facebook Stories, Reels, TikTok. Keeps the top 250 px and bottom 340 px clear for the app's buttons. |

They're built from `ads.html` with the real logo, the site's fonts and colours, and the default site photos. To change the wording or price, edit `ads.html` and run `node brand/ads/render.cjs`.

The copy only claims what the course does: 100% online, 10 modules, a proctored online exam, a certificate anyone can check on the verification page, and $89 CAD. Don't add "approved" or "recognised" claims until the recognition status is confirmed (see the go-live checklist in the main README). The product is called *Food Handler Certification*, not "FoodSafe": FOODSAFE is the name of British Columbia's own food safety program.
