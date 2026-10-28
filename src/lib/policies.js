// The site's policy pages, in the order they're listed in the sidebar, footer and the /policies hub.
// Change UPDATED whenever a policy's wording changes.
export const POLICIES_UPDATED = '2026-10-28T12:00:00Z';

export const POLICIES = [
  { path: '/terms', view: 'terms', title: 'Terms of use', summary: 'The rules for using this website and your account.' },
  { path: '/terms-of-sale', view: 'terms-of-sale', title: 'Terms and conditions of sale', summary: 'What you get when you buy the course, how payment works, and our responsibilities.' },
  { path: '/refunds', view: 'refunds', title: 'Refund policy', summary: 'When you can get your money back, and how to ask.' },
  { path: '/exam-policy', view: 'exam-policy', title: 'Exam and certificate policy', summary: 'Exam conditions, identity checks, retakes, appeals and certificate validity.' },
  { path: '/privacy', view: 'privacy', title: 'Privacy policy', summary: 'What we collect, why, how it’s protected and your choices. Includes cookies.' },
  { path: '/accessibility', view: 'accessibility', title: 'Accessibility', summary: 'How the course works with assistive technology, and how to ask for help.' },
  { path: '/copyright', view: 'copyright', title: 'Copyright and trademarks', summary: 'Who owns the course material and what you may do with it.' },
];
