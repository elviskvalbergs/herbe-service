// lib/documents/report-labels.ts
//
// Static UI labels for the built-in order report, in the 7 phase-1 tenant
// locales. Deliberately NOT wired through next-intl: the report renders in a
// cron job (no request, no RSC machinery), and these ~30 strings are the
// document's entire static vocabulary. Unknown/missing locales fall back to
// en; a region subtag ('lv-LV') resolves to its base language.

export const REPORT_LOCALES = ['en', 'et', 'fi', 'lv', 'lt', 'no', 'sv'] as const
export type ReportLocale = (typeof REPORT_LOCALES)[number]

export interface ReportLabels {
  serviceReport: string
  order: string
  status: string
  requested: string
  promised: string
  customer: string
  site: string
  contact: string
  serviceItems: string
  serial: string
  technicians: string
  crew: string
  workDescription: string
  fault: string
  cause: string
  remedy: string
  materialsAndServices: string
  description: string
  qty: string
  unit: string
  price: string
  sum: string
  workTime: string
  travelTime: string
  distance: string
  total: string
  totalTime: string
  signedOnSite: string
  generated: string
  noWorksheets: string
}

const LABELS: Record<ReportLocale, ReportLabels> = {
  en: {
    serviceReport: 'Service report',
    order: 'Order',
    status: 'Status',
    requested: 'Requested',
    promised: 'Promised',
    customer: 'Customer',
    site: 'Site',
    contact: 'Contact',
    serviceItems: 'Service items',
    serial: 'Serial no.',
    technicians: 'Technicians',
    crew: 'Crew',
    workDescription: 'Work description',
    fault: 'Fault',
    cause: 'Cause',
    remedy: 'Remedy',
    materialsAndServices: 'Materials & services',
    description: 'Description',
    qty: 'Qty',
    unit: 'Unit',
    price: 'Price',
    sum: 'Sum',
    workTime: 'Work time',
    travelTime: 'Travel time',
    distance: 'Distance',
    total: 'Total',
    totalTime: 'Total time',
    signedOnSite: 'Signed on site',
    generated: 'Generated',
    noWorksheets: 'No approved worksheets',
  },
  et: {
    serviceReport: 'Hooldusaruanne',
    order: 'Tellimus',
    status: 'Staatus',
    requested: 'Soovitud',
    promised: 'Lubatud',
    customer: 'Klient',
    site: 'Objekt',
    contact: 'Kontaktisik',
    serviceItems: 'Hooldatavad seadmed',
    serial: 'Seerianumber',
    technicians: 'Tehnikud',
    crew: 'Meeskond',
    workDescription: 'Töö kirjeldus',
    fault: 'Rike',
    cause: 'Põhjus',
    remedy: 'Lahendus',
    materialsAndServices: 'Materjalid ja teenused',
    description: 'Kirjeldus',
    qty: 'Kogus',
    unit: 'Ühik',
    price: 'Hind',
    sum: 'Summa',
    workTime: 'Tööaeg',
    travelTime: 'Sõiduaeg',
    distance: 'Läbisõit',
    total: 'Kokku',
    totalTime: 'Aeg kokku',
    signedOnSite: 'Allkirjastatud kohapeal',
    generated: 'Koostatud',
    noWorksheets: 'Kinnitatud töölehti pole',
  },
  fi: {
    serviceReport: 'Huoltoraportti',
    order: 'Tilaus',
    status: 'Tila',
    requested: 'Pyydetty',
    promised: 'Luvattu',
    customer: 'Asiakas',
    site: 'Kohde',
    contact: 'Yhteyshenkilö',
    serviceItems: 'Huoltokohteet',
    serial: 'Sarjanumero',
    technicians: 'Asentajat',
    crew: 'Työryhmä',
    workDescription: 'Työn kuvaus',
    fault: 'Vika',
    cause: 'Syy',
    remedy: 'Korjaus',
    materialsAndServices: 'Materiaalit ja palvelut',
    description: 'Kuvaus',
    qty: 'Määrä',
    unit: 'Yksikkö',
    price: 'Hinta',
    sum: 'Summa',
    workTime: 'Työaika',
    travelTime: 'Matka-aika',
    distance: 'Ajomatka',
    total: 'Yhteensä',
    totalTime: 'Aika yhteensä',
    signedOnSite: 'Allekirjoitettu paikan päällä',
    generated: 'Luotu',
    noWorksheets: 'Ei hyväksyttyjä työlomakkeita',
  },
  lv: {
    serviceReport: 'Servisa atskaite',
    order: 'Pasūtījums',
    status: 'Statuss',
    requested: 'Pieprasīts',
    promised: 'Apsolīts',
    customer: 'Klients',
    site: 'Objekts',
    contact: 'Kontaktpersona',
    serviceItems: 'Apkalpojamās iekārtas',
    serial: 'Sērijas numurs',
    technicians: 'Tehniķi',
    crew: 'Brigāde',
    workDescription: 'Darba apraksts',
    fault: 'Bojājums',
    cause: 'Cēlonis',
    remedy: 'Risinājums',
    materialsAndServices: 'Materiāli un pakalpojumi',
    description: 'Apraksts',
    qty: 'Daudzums',
    unit: 'Vienība',
    price: 'Cena',
    sum: 'Summa',
    workTime: 'Darba laiks',
    travelTime: 'Ceļa laiks',
    distance: 'Nobraukums',
    total: 'Kopā',
    totalTime: 'Laiks kopā',
    signedOnSite: 'Parakstīts objektā',
    generated: 'Sagatavots',
    noWorksheets: 'Nav apstiprinātu darba lapu',
  },
  lt: {
    serviceReport: 'Serviso ataskaita',
    order: 'Užsakymas',
    status: 'Būsena',
    requested: 'Pageidauta',
    promised: 'Pažadėta',
    customer: 'Klientas',
    site: 'Objektas',
    contact: 'Kontaktinis asmuo',
    serviceItems: 'Prižiūrima įranga',
    serial: 'Serijos numeris',
    technicians: 'Technikai',
    crew: 'Brigada',
    workDescription: 'Darbo aprašymas',
    fault: 'Gedimas',
    cause: 'Priežastis',
    remedy: 'Sprendimas',
    materialsAndServices: 'Medžiagos ir paslaugos',
    description: 'Aprašymas',
    qty: 'Kiekis',
    unit: 'Vienetas',
    price: 'Kaina',
    sum: 'Suma',
    workTime: 'Darbo laikas',
    travelTime: 'Kelionės laikas',
    distance: 'Atstumas',
    total: 'Iš viso',
    totalTime: 'Laikas iš viso',
    signedOnSite: 'Pasirašyta objekte',
    generated: 'Sudaryta',
    noWorksheets: 'Nėra patvirtintų darbo lapų',
  },
  no: {
    serviceReport: 'Servicerapport',
    order: 'Ordre',
    status: 'Status',
    requested: 'Ønsket',
    promised: 'Lovet',
    customer: 'Kunde',
    site: 'Anlegg',
    contact: 'Kontaktperson',
    serviceItems: 'Utstyr',
    serial: 'Serienummer',
    technicians: 'Teknikere',
    crew: 'Arbeidslag',
    workDescription: 'Arbeidsbeskrivelse',
    fault: 'Feil',
    cause: 'Årsak',
    remedy: 'Utbedring',
    materialsAndServices: 'Materialer og tjenester',
    description: 'Beskrivelse',
    qty: 'Antall',
    unit: 'Enhet',
    price: 'Pris',
    sum: 'Sum',
    workTime: 'Arbeidstid',
    travelTime: 'Reisetid',
    distance: 'Kjørelengde',
    total: 'Totalt',
    totalTime: 'Tid totalt',
    signedOnSite: 'Signert på stedet',
    generated: 'Opprettet',
    noWorksheets: 'Ingen godkjente arbeidsskjemaer',
  },
  sv: {
    serviceReport: 'Servicerapport',
    order: 'Order',
    status: 'Status',
    requested: 'Begärt',
    promised: 'Utlovat',
    customer: 'Kund',
    site: 'Anläggning',
    contact: 'Kontaktperson',
    serviceItems: 'Utrustning',
    serial: 'Serienummer',
    technicians: 'Tekniker',
    crew: 'Arbetslag',
    workDescription: 'Arbetsbeskrivning',
    fault: 'Fel',
    cause: 'Orsak',
    remedy: 'Åtgärd',
    materialsAndServices: 'Material och tjänster',
    description: 'Beskrivning',
    qty: 'Antal',
    unit: 'Enhet',
    price: 'Pris',
    sum: 'Summa',
    workTime: 'Arbetstid',
    travelTime: 'Restid',
    distance: 'Körsträcka',
    total: 'Totalt',
    totalTime: 'Total tid',
    signedOnSite: 'Signerad på plats',
    generated: 'Skapad',
    noWorksheets: 'Inga godkända arbetsblad',
  },
}

function isReportLocale(value: string): value is ReportLocale {
  return (REPORT_LOCALES as readonly string[]).includes(value)
}

/** Labels for a locale; region subtags stripped ('lv-LV' → 'lv'); unknown → en. */
export function getReportLabels(locale: string | undefined): ReportLabels {
  const base = locale?.toLowerCase().split('-')[0] ?? ''
  return isReportLocale(base) ? LABELS[base] : LABELS.en
}
