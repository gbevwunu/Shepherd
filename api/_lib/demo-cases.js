// Hand-authored demo cases with deliberately planted fabrications.
//
// These exist because Phase 1 is built not to fabricate, so waiting for a live
// hallucination is not a demo plan. Each case pairs a real seed source document
// with a hand-written patient summary containing exactly one unsupported claim.
//
// The planted summaries are NOT model output and must never be presented as if
// they were. Anything that surfaces one is responsible for labelling it — the
// UI shows a notice, and /api/summarize marks the response with a header.
//
// `expectedGrounding` is the canned result from the Phase 2 spec. It is used
// only in offline demo mode (SHEPHERD_USE_FIXTURES=1) and as the regression
// expectation in tests. The live endpoint runs the real model instead.

export const DEMO_CASES = {
  'DEMO-A-PNEUMONIA': {
    label: 'Demo — pneumonia summary with a planted error',
    sourceDocumentId: 'SYNTH-DISCHARGE-001',
    documentType: 'hospital discharge summary',

    // The bed-rest sentence is the plant. It sounds plausible and harmless,
    // which is the point: an unguarded summarizer would let it through.
    patientSummary: [
      'You had a lung infection called pneumonia in your right lung. You were given',
      'antibiotics through a vein in your arm, and your fever went away for two days',
      'before you went home. You have a new antibiotic to take by mouth twice a day for',
      'five days. You should also rest in bed for two full weeks and avoid all physical',
      'activity until then.',
      '',
      'Please see your family doctor in about a week, and get another chest X-ray in one',
      'to two months to make sure your lungs have healed.',
    ].join('\n'),

    plantedClaim: 'You should also rest in bed for two full weeks and avoid all physical activity until then.',

    clinicianHighlights: [
      'Dx: community-acquired pneumonia, RLL',
      'Tx: IV ceftriaxone + azithromycin; afebrile x48h pre-discharge',
      'D/C meds: amoxicillin-clavulanate 875/125 PO BID x5d',
      'F/U: PCP 7d; repeat CXR 4-6 wks',
    ],

    glossary: [
      { term: 'pneumonia', plain: 'a lung infection' },
      { term: 'antibiotics', plain: 'medicine that treats a bacterial infection' },
    ],

    expectedGrounding: {
      allGrounded: false,
      claims: [
        {
          text: 'You had a lung infection called pneumonia in your right lung.',
          grounded: true,
          sourceSpan: 'Dx: Community-acquired pneumonia, RLL.',
        },
        {
          text: 'You were given antibiotics through a vein in your arm, and your fever went away for two days before you went home.',
          grounded: true,
          sourceSpan: 'Hospital course: Started on IV ceftriaxone + azithromycin. Afebrile x48h prior to',
        },
        {
          text: 'You have a new antibiotic to take by mouth twice a day for five days.',
          grounded: true,
          sourceSpan: 'Discharge meds: PO amoxicillin-clavulanate 875/125 BID x5d. Continue home',
        },
        {
          text: 'You should also rest in bed for two full weeks and avoid all physical activity until then.',
          grounded: false,
          sourceSpan: null,
          reason:
            'The source document says nothing about bed rest or a two-week activity ' +
            'restriction. This instruction was not written by the clinician.',
        },
        {
          text: 'Please see your family doctor in about a week, and get another chest X-ray in one to two months to make sure your lungs have healed.',
          grounded: true,
          sourceSpan: 'Follow-up: PCP in 7d. Repeat CXR in ~4-6 wks to confirm resolution. RTC/ED',
        },
      ],
    },
  },

  'DEMO-B-APPENDECTOMY': {
    label: 'Demo — appendectomy summary with a planted error',
    sourceDocumentId: 'SYNTH-DISCHARGE-002',
    documentType: 'hospital discharge summary',

    // A different failure mode from Fixture A: this invents a medication
    // rather than an instruction.
    patientSummary: [
      'You had surgery to remove your appendix using a few small cuts (keyhole surgery),',
      'because it was inflamed. The surgery went smoothly. For pain, you can take',
      'acetaminophen and ibuprofen as needed. You were also prescribed an antibiotic to',
      'take for ten days to prevent infection.',
      '',
      "Don't lift anything heavier than about ten pounds for two weeks, and keep your cuts",
      'clean and dry. See the surgery clinic in about two weeks to check your wound and go',
      'over your results.',
    ].join('\n'),

    plantedClaim: 'You were also prescribed an antibiotic to take for ten days to prevent infection.',

    clinicianHighlights: [
      'Dx: acute appendicitis, s/p laparoscopic appendectomy',
      'Procedure: laparoscopic appendectomy, uncomplicated',
      'D/C meds: acetaminophen 500mg PO q6h PRN; ibuprofen 400mg PO q8h PRN',
      'F/U: surgery clinic 10-14d for wound check + path results',
    ],

    glossary: [
      { term: 'appendix', plain: 'a small pouch attached to the large intestine' },
      { term: 'keyhole surgery', plain: 'surgery done through a few small cuts' },
    ],

    expectedGrounding: {
      allGrounded: false,
      claims: [
        {
          text: 'You had surgery to remove your appendix using a few small cuts (keyhole surgery), because it was inflamed.',
          grounded: true,
          sourceSpan: 'Dx: Acute appendicitis, s/p laparoscopic appendectomy.',
        },
        {
          text: 'The surgery went smoothly.',
          grounded: true,
          sourceSpan: 'Procedure: Laparoscopic appendectomy, uncomplicated. EBL minimal. Appendix sent to',
        },
        {
          text: 'For pain, you can take acetaminophen and ibuprofen as needed.',
          grounded: true,
          sourceSpan: 'Discharge meds: Acetaminophen 500mg PO q6h PRN. Ibuprofen 400mg PO q8h PRN. Hold',
        },
        {
          text: 'You were also prescribed an antibiotic to take for ten days to prevent infection.',
          grounded: false,
          sourceSpan: null,
          reason:
            'The source lists only acetaminophen and ibuprofen at discharge. No ' +
            'antibiotic appears anywhere in the document.',
        },
        {
          text: "Don't lift anything heavier than about ten pounds for two weeks, and keep your cuts clean and dry.",
          grounded: true,
          sourceSpan: 'Activity: No heavy lifting >10 lbs x2 wks. May shower; keep incisions clean/dry.',
        },
        {
          text: 'See the surgery clinic in about two weeks to check your wound and go over your results.',
          grounded: true,
          sourceSpan: 'Follow-up: Surgery clinic in 10-14d for wound check + path results. RTC/ED for',
        },
      ],
    },
  },
};

export function isDemoCase(documentId) {
  return Object.prototype.hasOwnProperty.call(DEMO_CASES, documentId);
}
