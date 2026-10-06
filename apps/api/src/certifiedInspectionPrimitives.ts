// Existing Certified grade/result vocabulary, shared by purpose-specific flows.
export const certifiedGrades=['A+','A','B+','B','Parts / Repair'] as const;
export function legacyCertifiedGrade(grade:typeof certifiedGrades[number]):'A'|'B'|'D'{
  return grade==='A+'||grade==='A'?'A':grade==='B+'||grade==='B'?'B':'D';
}
