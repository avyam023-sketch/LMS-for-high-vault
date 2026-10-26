import { z } from 'zod';

/** Parses req.body with a zod schema. Returns { data } or { errors: {field: message} }. */
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  const errors = {};
  for (const issue of result.error.issues) errors[issue.path.join('.') || 'form'] ??= issue.message;
  return { errors };
}

export const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
// Names print on certificates, so restrict to Latin-script letters and common punctuation.
export const personName = z
  .string()
  .trim()
  .min(1, 'Required.')
  .max(60, 'Too long.')
  .regex(/^[\p{Script=Latin}][\p{Script=Latin}\p{M} .'-]*$/u, 'Use letters, spaces, hyphens or apostrophes only.');
export const uuid = z.uuid();
