import crypto from 'node:crypto';
import { fakerEN_CA as faker } from '@faker-js/faker';
import type { CustomRule, PiiEntityType, RedactionMode } from '../src/types.ts';

export interface DetectedSpan {
  entityType: PiiEntityType;
  ruleLabel?: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  mockTemplate?: string;
}

export interface DetectPiiOptions {
  ignoreCibcEmployees?: boolean;
  extraIgnoredPersonKeys?: Set<string>;
}

export const ALL_PII_ENTITIES: PiiEntityType[] = [
  'PERSON',
  'SIN',
  'CANADIAN_BANK_ACCOUNT',
  'ADDRESS',
  'PHONE',
  'EMAIL',
  'CREDIT_CARD',
  'DOB',
  'LEGAL_CASE_ID',
  'PASSPORT',
];

function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function luhnValid(raw: string, minLen = 13, maxLen = 19): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < minLen || digits.length > maxLen) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function sinLuhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 9) return false;
  if (digits[0] === '0' || digits[0] === '8') return false;
  return luhnValid(digits, 9, 9);
}

const CA_PROVINCES = '(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)';
const CA_POSTAL_STR = '[ABCEGHJKLMNPRSTVXY]\\d[ABCEGHJKLMNPRSTVWXYZ][ -]?\\d[ABCEGHJKLMNPRSTVWXYZ]\\d';
const CA_STREET_SUFFIX =
  '(?:Street|St|Avenue|Ave|Boulevard|Blvd|Boul|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Crescent|Cres|Parkway|Pkwy|Circle|Cir|Place|Pl|Trail|Tr|Terrace|Terr|Terrasse|Croissant|Promenade|Sentier)';
const CA_FR_PREFIX = '(?:Rue|Avenue|Boulevard|Boul\\.?|Chemin|Ch\\.?|Allée|Allee|Impasse|Place|Rang|Route|Côte|Cote|Carré|Carre)';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CIBC_EMAIL_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*cibc\.(?:com|ca)$/i;

// Canadian SIN / NAS (XXX-XXX-XXX or XXX XXX XXX)
const SIN_LABELED_RE =
  /(?:(?:SIN|NAS|Social[ \t]+Insurance[ \t]+(?:Number|No\.?)|Num[eé]ro[ \t]+d['’]assurance[ \t]+sociale|N[°o]?[ \t]*d['’]assurance[ \t]+sociale)[ \t]*(?:[:\-#][ \t]*|\n[ \t]*))(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi;
const SIN_DASH_RE = /\b[1-79]\d{2}-\d{3}-\d{3}\b/g;
const SIN_SPACE_RE = /\b[1-79]\d{2} \d{3} \d{3}\b/g;

const PHONE_FORMATTED_RE = /(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\d{3}[-.\s])\d{3}[-.\s]\d{4})\b/g;
const PHONE_COMPACT_RE = /\b(?:\+?1)?\d{10}\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{13,19}\b/g;

// Canadian Transit-Institution-Account & English/French Registered Plan / Account IDs
const BANK_TRANSIT_TUPLE_RE = /\b\d{5}[-\s]\d{3}[-\s]\d{7,12}\b/g;
const BANK_LABELED_ACCOUNT_RE =
  /(?:(?:LIRA|RRSP|TFSA|RRIF|RESP|RDSP|FHSA|LIF|PRPP|SPP|REER|FERR|CELI|REEE|CRI|FRV|REEI|CELIAPP|RPDB|Receiving[ \t]+Plan|Relinquishing[ \t]+Plan|Plan|Account|Acct|Chequing|Savings|Mortgage|Policy|Contract|Certificate|Client[ \t]*ID|Member|Transit|Institution|EFT|Num[eé]ro[ \t]+de[ \t]+compte|N[°o]?[ \t]+de[ \t]+compte|Num[eé]ro[ \t]+de[ \t]+r[eé]gime|N[°o]?[ \t]+de[ \t]+r[eé]gime|Num[eé]ro[ \t]+de[ \t]+contrat|Num[eé]ro[ \t]+de[ \t]+police|Num[eé]ro[ \t]+client|Num[eé]ro[ \t]+de[ \t]+membre|Compte|R[eé]gime|Contrat|Police|Succursale|NEQ)[ \t]*(?:No\.?|Number|#)?[ \t]*(?:[:\-#][ \t]*|[ \t]*\n[ \t]*))([A-Z]{0,5}[-]?\d{3,14}(?:[- ]\d{1,12}){0,3}|[A-Z]{1,4}\d{4,12})\b/gi;

// Canadian Court File / Divorce Docket / CRA & Revenu Quebec Business / Tax Reference IDs
const CRA_BN_RE = /\b\d{9}[ \t]?(?:RP|RC|RT|RR|RQ)[ \t]?\d{4}\b/g;
const LEGAL_CASE_RE =
  /(?:(?:Court[ \t]*File|Docket|Action|Divorce[ \t]*File|Case|CRA[ \t]*(?:Ref|Payroll|Business)|Notice[ \t]*Ref|Num[eé]ro[ \t]+de[ \t]+dossier|Dossier[ \t]+de[ \t]+la[ \t]+cour|Dossier|R[eé]f[eé]rence[ \t]+(?:ARC|Revenu[ \t]+Qu[eé]bec)|N[°o]?[ \t]+d['’]avis)[ \t]*(?:No\.?|Number|#)?[ \t]*(?:[:\-#][ \t]*|[ \t]*\n[ \t]*))([A-Z0-9]{2,6}(?:[- ][A-Z0-9]{2,10}){1,3})\b/gi;

const FR_MONTHS =
  '(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)';
const EN_MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';

const DOB_RE = new RegExp(
  `(?:(?:DOB|Date[ \\t]+of[ \\t]+Birth|Birth[ \\t]*Date|Born|Date[ \\t]+of[ \\t]+Marriage|Separation[ \\t]+Date|Date[ \\t]+de[ \\t]+naissance|DDN|N[eé]e?[ \\t]+le|Date[ \\t]+de[ \\t]+mariage|Date[ \\t]+de[ \\t]+s[eé]paration|Date[ \\t]+de[ \\t]+rupture)[ \\t]*(?:[:\\-][ \\t]*|\\n[ \\t]*))(` +
    `(?:0?[1-9]|1[0-2])[/\\-](?:0?[1-9]|[12]\\d|3[01])[/\\-](?:19|20)\\d{2}|` +
    `(?:19|20)\\d{2}[/\\-](?:0?[1-9]|1[0-2])[/\\-](?:0?[1-9]|[12]\\d|3[01])|` +
    `${EN_MONTHS}[ \\t]+\\d{1,2},?[ \\t]+(?:19|20)\\d{2}|` +
    `\\d{1,2}[ \\t]+${FR_MONTHS}[ \\t]+(?:19|20)\\d{2}` +
    `)`,
  'gi'
);

const ADDRESS_FULL_CA_RE = new RegExp(
  `\\b\\d{1,6}[ \\t]+(?:(?:${CA_FR_PREFIX})[ \\t]+)?(?:[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \\t]+){1,5}` +
    `(?:${CA_STREET_SUFFIX}\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?)?` +
    `(?:,[ \\t]*(?:Apt|Suite|Ste|Unit|App\\.?|Appartement|Bureau|Unit[eé]|#)[ \\t]*[A-Za-z0-9-]+)?` +
    `,[ \\t]*[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ.\\- ]+,[ \\t]*${CA_PROVINCES}[ \\t]+${CA_POSTAL_STR}(?:,[ \\t]*Canada)?\\b`,
  'g'
);

const ADDRESS_STREET_RE = new RegExp(
  `\\b\\d{1,6}[ \\t]+(?:(?:${CA_FR_PREFIX})[ \\t]+)?(?:[A-ZÀ-Ÿ][a-zA-ZÀ-ÿ0-9.'-]+[ \\t]+){1,4}` +
    `${CA_STREET_SUFFIX}\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S|Ouest|Est|Nord|Sud))?` +
    `(?:,[ \\t]*(?:Apt|Suite|Ste|Unit|App\\.?|Appartement|Bureau|Unit[eé]|#)[ \\t]*[A-Za-z0-9-]+)?\\b`,
  'g'
);

const ADDRESS_FR_LINE_RE = new RegExp(
  `\\b\\d{1,6}(?:,[ \\t]*|[ \\t]+)${CA_FR_PREFIX}[ \\t]+[A-ZÀ-Ÿa-zà-ÿ0-9.'-]+(?:[ \\t]+[A-ZÀ-Ÿa-zà-ÿ0-9.'-]+){0,4}(?:,[ \\t]*(?:App\\.?|Appartement|Bureau|Suite|#)[ \\t]*[A-Za-z0-9-]+)?\\b`,
  'g'
);

const POSTAL_CODE_ONLY_RE = new RegExp(`\\b${CA_POSTAL_STR}\\b`, 'g');

const PASSPORT_RE =
  /(?:(?:Passport|Passeport|DL|Driver'?s?[ \t]*Licen[cs]e|Ontario[ \t]*DL|Permis[ \t]+de[ \t]+conduire|ID[ \t]*No\.?)[ \t]*[:\-#]?[ \t]*)([A-Z0-9-]{6,18})\b/gi;

// Person name patterns (Title Case, French Accented, Hyphenated, and ALL CAPS)
const NAME_PART_TITLE = "[A-ZÀ-Ÿ][a-zà-ÿ'-]{1,22}(?:-[A-ZÀ-Ÿ][a-zà-ÿ'-]{1,22})?";
const NAME_PART_CAPS = "[A-ZÀ-Ÿ]{2,20}(?:-[A-ZÀ-Ÿ]{2,20})?";
const NAME_PART_ANY = `(?:${NAME_PART_TITLE}|${NAME_PART_CAPS})`;

const PERSON_LABELS_COLON =
  '(?:Account[ \\t]*Holder|Client(?:[ \\t]*Name)?|Customer(?:[ \\t]*Name)?|Employee(?:[ \\t]*Name)?|Applicant|Petitioner|Respondent|Spouse|Former[ \\t]*Spouse|Beneficiary|Contingent[ \\t]*Beneficiary|Subscriber|Joint[ \\t]*Subscriber|Plan[ \\t]*Holder|Holder|Annuitant|Contributor|Legal[ \\t]*Name(?:[ \\t]+of[ \\t]+[^:\\n]{1,35})?|Payor|Payee|Taxpayer|Trustee|Executor|Patient|Full[ \\t]*Name|First[ \\t]*Name|Last[ \\t]*Name|Given[ \\t]*Name|Surname|Name|Cardholder|Signed[ \\t]*by|Prepared[ \\t]*for|Requested[ \\t]*by|Attn|Dear|Mr\\.|Mrs\\.|Ms\\.|Dr\\.|Contact[ \\t]*Name|' +
  "Nom[ \\t]+du[ \\t]+client|Nom[ \\t]+complet|Nom[ \\t]+et[ \\t]+pr[eé]nom|Pr[eé]nom[ \\t]+et[ \\t]+nom|Pr[eé]nom|Nom[ \\t]+de[ \\t]+famille|Titulaire(?:[ \\t]+du[ \\t]+(?:compte|r[eé]gime))?|Cotitulaire|Souscripteur|Rentier|B[eé]n[eé]ficiaire|Conjoint(?:e)?|Ex-conjoint(?:e)?|Demandeur|D[eé]fendeur|D[eé]biteur|Contribuable|Fiduciaire|Liquidateur|Employ[eé]e?|Sign[eé][ \\t]+par|Pr[eé]par[eé][ \\t]+pour|[ÀA][ \\t]+l['’]attention[ \\t]+de|Monsieur|Madame|M\\.|Mme|Mlle|Personne-ressource)";

const PERSON_LABELS_NEWLINE =
  '(?:\\*?[ \\t]*(?:Account[ \\t]*Holder|Client[ \\t]*Name|Full[ \\t]*Name|Subscriber[ \\t]*Name|Annuitant[ \\t]*Name|Beneficiary[ \\t]*Name|Contact[ \\t]*Name|First[ \\t]*Name|Last[ \\t]*Name|Nom[ \\t]+du[ \\t]+client|Nom[ \\t]+complet|Pr[eé]nom[ \\t]+et[ \\t]+nom|Titulaire[ \\t]+du[ \\t]+compte|Souscripteur|B[eé]n[eé]ficiaire))';

const PERSON_CONTEXT_RE = new RegExp(
  `(?:${PERSON_LABELS_COLON}[ \\t]*[:\\-][ \\t]*|${PERSON_LABELS_NEWLINE}[ \\t]*\\n[ \\t]*)` +
    `(${NAME_PART_ANY}(?:[ \\t]+[A-ZÀ-Ÿ]\\.?)?[ \\t]+${NAME_PART_ANY}(?:[ \\t]+${NAME_PART_ANY})?)`,
  'g'
);

const PERSON_STANDALONE_RE = new RegExp(
  `\\b(${NAME_PART_TITLE}(?:[ \\t]+[A-Z]\\.)?[ \\t]+${NAME_PART_TITLE}|${NAME_PART_CAPS}(?:[ \\t]+[A-Z]\\.)?[ \\t]+${NAME_PART_CAPS})\\b`,
  'g'
);

const COMMON_NON_PERSON_BIGRAMS = new Set([
  'San Francisco',
  'New York',
  'North York',
  'Superior Court',
  'Family Court',
  'Notice Assessment',
  'Direct Deposit',
  'Payment Card',
  'Account Recovery',
  'Social Insurance',
  'Royal Bank',
  'Canada Revenue',
  'Revenue Agency',
  'Revenu Quebec',
  'Locked Retirement',
  'Gross Earnings',
  'Net Pay',
  'Bank Statement',
  'King Street',
  'Queen Street',
  'Yonge Street',
  'Mutual Funds',
  'Savings Plan',
  'Beneficiary Plan',
  'Family Beneficiary',
  'Registered Education',
  'Branch Contact',
  'Contact Information',
  'Client Instructions',
  'Client Information',
  'In Cash',
  'Common Law',
  'Registered Investments',
]);

// Folded lowercase words that should never be part of a standalone PERSON match
const COMMON_NON_PERSON_WORDS = new Set([
  'account', 'number', 'type', 'plan', 'mutual', 'funds', 'fund', 'savings', 'education',
  'registered', 'family', 'beneficiary', 'statement', 'period', 'balance', 'opening',
  'closing', 'change', 'value', 'total', 'investments', 'investment', 'contributions',
  'contribution', 'summary', 'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december', 'bank', 'royal',
  'canada', 'canadian', 'toronto', 'dominion', 'montreal', 'vancouver', 'calgary',
  'ottawa', 'ontario', 'quebec', 'alberta', 'british', 'columbia', 'manitoba',
  'saskatchewan', 'street', 'avenue', 'boulevard', 'road', 'drive', 'suite', 'north',
  'south', 'east', 'west', 'direct', 'deposit', 'tax', 'federal', 'provincial',
  'notice', 'assessment', 'superior', 'court', 'justice', 'divorce', 'order', 'rules',
  'pay', 'gross', 'net', 'deductions', 'earnings', 'page', 'your', 'have', 'question',
  'need', 'know', 'glance', 'amount', 'date', 'detail', 'details', 'information',
  'profile', 'contact', 'address', 'phone', 'email', 'postal', 'code', 'transit',
  'branch', 'institution', 'chequing', 'mortgage', 'income', 'return', 'limit',
  'deduction', 'year', 'month', 'resp', 'tfsa', 'rrsp', 'lira', 'rrif', 'rdsp', 'fhsa',
  'lif', 'prpp', 'spp', 'qesi', 'tisa', 'gic', 'cibc', 'investors', 'investor', 'wood',
  'gundy', 'scotiabank', 'scotia', 'desjardins', 'laurentienne', 'bmo', 'rbc', 'bnc',
  'interest', 'rate', 'market', 'unit', 'units', 'price', 'fees', 'fee', 'service',
  'services', 'client', 'clients', 'instructions', 'banking', 'centre', 'transfers',
  'transfer', 'within', 'refers', 'other', 'financial', 'institutions', 'cash', 'kind',
  'corporate', 'estate', 'trust', 'partnership', 'individual', 'joint', 'part',
  'authorization', 'record', 'locked', 'retirement', 'holder', 'consent', 'form',
  'breakdown', 'marriage', 'common', 'law', 'subparagraph', 'subsection', 'section',
  'single', 'supporting', 'documents', 'document', 'incentive', 'relinquishing',
  'receiving', 'legal', 'business', 'city', 'province', 'country',
  // French banking / form vocabulary (accent-folded)
  'compte', 'titulaire', 'souscripteur', 'beneficiaire', 'rentier', 'conjoint', 'conjointe',
  'regime', 'epargne', 'retraite', 'etudes', 'transfert', 'formulaire', 'renseignements',
  'succursale', 'coordonnees', 'banque', 'placements', 'revenu', 'numero', 'assurance',
  'sociale', 'adresse', 'ville', 'téléphone', 'telephone', 'courriel', 'naissance',
  'mariage', 'rupture', 'separation', 'montant', 'solde', 'periode', 'releve',
  'instruction', 'particulier', 'entreprise', 'fiducie', 'societe', 'mandat',
  'procuration', 'signature', 'annexe', 'partie', 'reer', 'ferr', 'celi', 'reee',
  'cri', 'frv', 'reei', 'celiapp', 'rpdb', 'iqee', 'caisse', 'nationale', 'epargnes',
  'enregistre', 'enregistree', 'non', 'oui', 'janvier', 'fevrier', 'mars', 'avril',
  'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
  'personne', 'ressource', 'representant', 'conseiller', 'directeur',
]);

const COMMON_FIRST_NAMES = new Set([
  'aaron', 'abigail', 'adam', 'adrian', 'aidan', 'aiden', 'alain', 'alan', 'albert', 'alex',
  'alexander', 'alexandra', 'alexandre', 'alexis', 'alice', 'alicia', 'alison', 'allison',
  'amanda', 'amber', 'amelia', 'amelie', 'amy', 'andre', 'andrea', 'andrew', 'angela', 'anna',
  'anne', 'annie', 'anthony', 'antoine', 'aria', 'ariel', 'arthur', 'ashley', 'aubrey', 'audrey',
  'austin', 'ava', 'avery', 'barbara', 'beatrice', 'benjamin', 'benoit', 'bernard', 'bethany',
  'blake', 'brandon', 'brenda', 'brian', 'brianna', 'brigitte', 'brittany', 'brooke', 'brooklyn',
  'bruce', 'bryan', 'caleb', 'cameron', 'camila', 'camille', 'carl', 'carole', 'caroline',
  'carter', 'catherine', 'chantal', 'charles', 'charlotte', 'chase', 'chloe', 'christian',
  'christina', 'christine', 'christopher', 'claire', 'clara', 'claude', 'claudette', 'cole',
  'colette', 'colin', 'connor', 'cooper', 'cynthia', 'daniel', 'danielle', 'david', 'dean',
  'deborah', 'denis', 'denise', 'derek', 'diana', 'diane', 'dominic', 'dominique', 'donald',
  'donna', 'dorothy', 'douglas', 'dylan', 'edward', 'eleanor', 'elena', 'elijah', 'elise',
  'elizabeth', 'ella', 'ellen', 'ellie', 'elliot', 'emilia', 'emilie', 'emily', 'emma', 'eric',
  'erica', 'erik', 'erin', 'ethan', 'etienne', 'eugene', 'eva', 'evan', 'evelyn', 'faith',
  'felix', 'fiona', 'florence', 'frances', 'francine', 'francis', 'francois', 'frank',
  'frederick', 'gabriel', 'gabrielle', 'gaetan', 'gary', 'gavin', 'genevieve', 'george',
  'gerald', 'gianna', 'gilles', 'grace', 'graham', 'grant', 'gregory', 'guillaume', 'hailey',
  'hannah', 'harold', 'harper', 'harrison', 'harry', 'hayden', 'hazel', 'heather', 'helen',
  'helene', 'henri', 'henry', 'holly', 'howard', 'hugo', 'hunter', 'ian', 'isaac', 'isabella',
  'isabelle', 'jack', 'jackson', 'jacob', 'jacqueline', 'jacques', 'jade', 'james', 'jamie',
  'jane', 'janet', 'janice', 'jared', 'jason', 'jayden', 'jean', 'jean-francois', 'jean-luc',
  'jean-marc', 'jean-pierre', 'jeanne', 'jeffrey', 'jennifer', 'jeremy', 'jerome', 'jerry',
  'jesse', 'jessica', 'jill', 'joan', 'joanne', 'jocelyn', 'jocelyne', 'joe', 'joel',
  'johanne', 'john', 'jonathan', 'jordan', 'josee', 'joseph', 'joshua', 'joyce', 'juan',
  'judith', 'judy', 'julia', 'julian', 'julie', 'julien', 'juliette', 'justin', 'karen',
  'katherine', 'kathleen', 'kathryn', 'katie', 'kayla', 'keith', 'kelly', 'kenneth', 'kevin',
  'kimberly', 'kyle', 'laura', 'laurence', 'lauren', 'laurent', 'lawrence', 'layla', 'lea',
  'leah', 'leilani', 'leo', 'leonard', 'leslie', 'liam', 'lillian', 'lily', 'linda', 'lindsay',
  'lisa', 'lise', 'logan', 'lori', 'louis', 'louise', 'luc', 'lucas', 'lucie', 'lucy', 'luke',
  'luna', 'lyne', 'lynn', 'madeleine', 'madeline', 'madison', 'manon', 'marc', 'marcus',
  'margaret', 'marguerite', 'maria', 'marianne', 'marie', 'marie-claire', 'marie-eve',
  'marie-pier', 'marilyn', 'mario', 'mark', 'martha', 'martin', 'martine', 'mary', 'mason',
  'mateo', 'mathieu', 'matthew', 'maureen', 'max', 'maxime', 'maya', 'megan', 'melanie',
  'melissa', 'mia', 'michael', 'michel', 'michele', 'michelle', 'mila', 'miles', 'mitchell',
  'molly', 'monica', 'monique', 'morgan', 'nadia', 'nancy', 'naomi', 'natalie', 'nathalie',
  'nathan', 'nathaniel', 'neil', 'nicholas', 'nicolas', 'nicole', 'noah', 'noemie', 'nolan',
  'nora', 'norman', 'odette', 'oliver', 'olivia', 'olivier', 'owen', 'paige', 'pamela',
  'parker', 'pascal', 'patricia', 'patrick', 'paul', 'paula', 'paule', 'pauline', 'penelope',
  'peter', 'philip', 'philippe', 'pierre', 'pierrette', 'rachel', 'ralph', 'randall',
  'raphael', 'raymond', 'real', 'rebecca', 'regina', 'rejean', 'remi', 'rene', 'renee',
  'richard', 'riley', 'robert', 'robin', 'roger', 'roland', 'ronald', 'rosalie', 'rose',
  'rosemarie', 'ross', 'roy', 'ruby', 'russell', 'ruth', 'ryan', 'sabrina', 'samantha',
  'samuel', 'sandra', 'sandrine', 'sara', 'sarah', 'savannah', 'scarlett', 'scott', 'sean',
  'sebastian', 'sebastien', 'serge', 'sharon', 'shawn', 'sheila', 'shelby', 'shirley',
  'simon', 'sofia', 'sophia', 'sophie', 'spencer', 'stacy', 'stanley', 'stella', 'stephane',
  'stephanie', 'stephen', 'steve', 'steven', 'stuart', 'susan', 'suzanne', 'sydney',
  'sylvain', 'sylvia', 'sylvie', 'tammy', 'tanya', 'tara', 'taylor', 'teresa', 'terry',
  'theresa', 'thierry', 'thomas', 'timothy', 'tina', 'todd', 'tom', 'tony', 'tracy', 'travis',
  'trevor', 'troy', 'tyler', 'valerie', 'vanessa', 'veronique', 'victor', 'victoria',
  'vincent', 'violet', 'virginia', 'virginie', 'walter', 'wanda', 'warren', 'wayne', 'wendy',
  'wesley', 'william', 'willow', 'wyatt', 'xavier', 'yves', 'yvon', 'zachary', 'zoe', 'zoey',
]);

export function extractCibcContext(text: string): {
  cibcEmployeeNameKeys: Set<string>;
  cibcZones: Array<{ start: number; end: number }>;
} {
  const cibcEmployeeNameKeys = new Set<string>();
  const cibcZones: Array<{ start: number; end: number }> = [];

  // 1. Collect normalized names from any @cibc.com / @cibc.ca email local part
  EMAIL_RE.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = EMAIL_RE.exec(text)) !== null) {
    const email = em[0];
    if (CIBC_EMAIL_DOMAIN_RE.test(email)) {
      const local = email.split('@')[0];
      const cleaned = foldAccents(local).replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim().toLowerCase();
      if (cleaned.length >= 4) {
        cibcEmployeeNameKeys.add(cleaned);
        const parts = cleaned.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          cibcEmployeeNameKeys.add(`${parts[0]} ${parts[parts.length - 1]}`);
        }
      }
    }
  }

  // 2. Identify Branch Contact / CIBC Representative blocks when document is CIBC-related
  const hasCibcBranding = /\bCIBC\b/i.test(text);
  const zoneStartRe =
    /(?:Branch[ \t]+Contact[ \t]+Information|CIBC[ \t]+(?:Branch[ \t]+)?Contact(?:[ \t]+Information)?|CIBC[ \t]+Representative|CIBC[ \t]+Advisor|Coordonn[eé]es[ \t]+de[ \t]+la[ \t]+succursale|Renseignements[ \t]+sur[ \t]+(?:le[ \t]+contact[ \t]+de[ \t]+)?la[ \t]+succursale|Conseiller[ \t]+CIBC|Repr[eé]sentant[ \t]+CIBC)/gi;
  const zoneEndRe =
    /(?:Client[ \t]+Information|Account[ \t]+Holder|Corporate\/|Investor[ \t]+Information|Subscriber[ \t]+Information|Plan[ \t]+Holder|Relinquishing[ \t]+Institution|Renseignements[ \t]+sur[ \t]+le[ \t]+client|Titulaire[ \t]+du[ \t]+compte|Souscripteur)/gi;

  let zs: RegExpExecArray | null;
  while ((zs = zoneStartRe.exec(text)) !== null) {
    const matchedHeading = zs[0];
    const isExplicitCibc = /cibc/i.test(matchedHeading);
    if (!isExplicitCibc && !hasCibcBranding) continue;

    const start = zs.index;
    zoneEndRe.lastIndex = start + matchedHeading.length;
    const ze = zoneEndRe.exec(text);
    const end = ze ? Math.min(ze.index, start + 450) : Math.min(text.length, start + 350);
    cibcZones.push({ start, end });
  }

  return { cibcEmployeeNameKeys, cibcZones };
}

function isInRanges(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => start >= r.start && end <= r.end);
}

function normalizePersonKey(name: string): string {
  return foldAccents(name).replace(/[^a-zA-Z\s-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function runRegex(
  regex: RegExp,
  text: string,
  captureGroup: number,
  callback: (matchText: string, start: number, end: number) => void
) {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const target = captureGroup > 0 ? m[captureGroup] : m[0];
    if (!target) continue;
    const offsetInFull = captureGroup > 0 ? m[0].lastIndexOf(target) : 0;
    const start = m.index + Math.max(0, offsetInFull);
    const end = start + target.length;
    callback(target, start, end);
  }
}

export function detectPiiInText(
  text: string,
  enabledEntities: PiiEntityType[],
  customRules: CustomRule[] = [],
  options: DetectPiiOptions = {}
): DetectedSpan[] {
  const enabled = new Set<PiiEntityType>(enabledEntities);
  const ignoreCibc = options.ignoreCibcEmployees !== false;
  const { cibcEmployeeNameKeys, cibcZones } = ignoreCibc
    ? extractCibcContext(text)
    : { cibcEmployeeNameKeys: new Set<string>(), cibcZones: [] };
  if (ignoreCibc && options.extraIgnoredPersonKeys) {
    for (const k of options.extraIgnoredPersonKeys) {
      cibcEmployeeNameKeys.add(k);
    }
  }
  const candidates: DetectedSpan[] = [];

  if (enabled.has('EMAIL')) {
    runRegex(EMAIL_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && CIBC_EMAIL_DOMAIN_RE.test(matchText)) return;
      candidates.push({ entityType: 'EMAIL', text: matchText, start, end, confidence: 0.99 });
    });
  }

  if (enabled.has('SIN')) {
    runRegex(SIN_LABELED_RE, text, 1, (matchText, start, end) => {
      const conf = sinLuhnValid(matchText) ? 0.98 : 0.9;
      candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: conf });
    });
    runRegex(SIN_DASH_RE, text, 0, (matchText, start, end) => {
      if (sinLuhnValid(matchText)) {
        candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: 0.96 });
      }
    });
    runRegex(SIN_SPACE_RE, text, 0, (matchText, start, end) => {
      if (sinLuhnValid(matchText)) {
        candidates.push({ entityType: 'SIN', text: matchText, start, end, confidence: 0.88 });
      }
    });
  }

  if (enabled.has('CREDIT_CARD')) {
    runRegex(CREDIT_CARD_RE, text, 0, (matchText, start, end) => {
      if (luhnValid(matchText)) {
        candidates.push({ entityType: 'CREDIT_CARD', text: matchText, start, end, confidence: 0.98 });
      }
    });
  }

  if (enabled.has('CANADIAN_BANK_ACCOUNT')) {
    runRegex(BANK_TRANSIT_TUPLE_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      candidates.push({
        entityType: 'CANADIAN_BANK_ACCOUNT',
        text: matchText,
        start,
        end,
        confidence: 0.95,
      });
    });
    runRegex(BANK_LABELED_ACCOUNT_RE, text, 1, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      if ((matchText.match(/\d/g) ?? []).length < 3) return;
      candidates.push({
        entityType: 'CANADIAN_BANK_ACCOUNT',
        text: matchText,
        start,
        end,
        confidence: 0.93,
      });
    });
  }

  if (enabled.has('LEGAL_CASE_ID')) {
    runRegex(CRA_BN_RE, text, 0, (matchText, start, end) => {
      candidates.push({ entityType: 'LEGAL_CASE_ID', text: matchText, start, end, confidence: 0.96 });
    });
    runRegex(LEGAL_CASE_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'LEGAL_CASE_ID', text: matchText, start, end, confidence: 0.92 });
    });
  }

  if (enabled.has('PHONE')) {
    runRegex(PHONE_FORMATTED_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      const trimmed = matchText.trim();
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) {
        candidates.push({ entityType: 'PHONE', text: trimmed, start, end: start + trimmed.length, confidence: 0.92 });
      }
    });
    runRegex(PHONE_COMPACT_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      const trimmed = matchText.trim();
      candidates.push({ entityType: 'PHONE', text: trimmed, start, end: start + trimmed.length, confidence: 0.76 });
    });
  }

  if (enabled.has('DOB')) {
    runRegex(DOB_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'DOB', text: matchText, start, end, confidence: 0.94 });
    });
  }

  if (enabled.has('ADDRESS')) {
    runRegex(ADDRESS_FULL_CA_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.94 });
    });
    runRegex(ADDRESS_STREET_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.88 });
    });
    runRegex(ADDRESS_FR_LINE_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.88 });
    });
    runRegex(POSTAL_CODE_ONLY_RE, text, 0, (matchText, start, end) => {
      if (ignoreCibc && isInRanges(start, end, cibcZones)) return;
      candidates.push({ entityType: 'ADDRESS', text: matchText, start, end, confidence: 0.91 });
    });
  }

  if (enabled.has('PASSPORT')) {
    runRegex(PASSPORT_RE, text, 1, (matchText, start, end) => {
      candidates.push({ entityType: 'PASSPORT', text: matchText, start, end, confidence: 0.9 });
    });
  }

  if (enabled.has('PERSON')) {
    runRegex(PERSON_CONTEXT_RE, text, 1, (matchText, start, end) => {
      const cleaned = matchText.trim();
      if (cleaned.length < 5 || COMMON_NON_PERSON_BIGRAMS.has(cleaned)) return;
      const lowerParts = cleaned
        .split(/\s+/)
        .map((p) => foldAccents(p).replace(/[^a-zA-Z-]/g, '').toLowerCase())
        .filter(Boolean);
      if (lowerParts.length < 2) return;
      if (lowerParts.some((w) => COMMON_NON_PERSON_WORDS.has(w))) return;
      if (ignoreCibc) {
        if (isInRanges(start, end, cibcZones)) return;
        const norm = normalizePersonKey(cleaned);
        if (cibcEmployeeNameKeys.has(norm)) return;
      }
      candidates.push({ entityType: 'PERSON', text: cleaned, start, end: start + cleaned.length, confidence: 0.91 });
    });

    runRegex(PERSON_STANDALONE_RE, text, 1, (matchText, start, end) => {
      const cleaned = matchText.trim();
      if (cleaned.length < 6 || COMMON_NON_PERSON_BIGRAMS.has(cleaned)) return;
      const lowerParts = cleaned
        .split(/\s+/)
        .map((p) => foldAccents(p).replace(/[^a-zA-Z-]/g, '').toLowerCase())
        .filter(Boolean);
      if (lowerParts.length < 2) return;
      if (lowerParts.some((w) => COMMON_NON_PERSON_WORDS.has(w))) return;
      if (lowerParts.some((w) => w.split('-').some((seg) => COMMON_NON_PERSON_WORDS.has(seg)))) return;
      if (ignoreCibc) {
        if (isInRanges(start, end, cibcZones)) return;
        const norm = normalizePersonKey(cleaned);
        if (cibcEmployeeNameKeys.has(norm)) return;
      }
      const firstWord = lowerParts[0];
      const firstBase = firstWord.split('-')[0];
      const conf =
        COMMON_FIRST_NAMES.has(firstWord) || COMMON_FIRST_NAMES.has(firstBase) ? 0.9 : 0.78;
      candidates.push({ entityType: 'PERSON', text: cleaned, start, end: start + cleaned.length, confidence: conf });
    });
  }

  for (const rule of customRules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;
    try {
      const re = new RegExp(rule.pattern, 'g');
      runRegex(re, text, 0, (matchText, start, end) => {
        candidates.push({
          entityType: 'CUSTOM',
          ruleLabel: rule.label,
          text: matchText,
          start,
          end,
          confidence: 0.95,
          mockTemplate: rule.mockTemplate,
        });
      });
    } catch {
      // Ignore invalid user regex safely
    }
  }

  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.confidence - a.confidence;
  });

  const deduped: DetectedSpan[] = [];
  let cursor = -1;
  for (const span of candidates) {
    if (span.start >= cursor) {
      deduped.push(span);
      cursor = span.end;
    }
  }
  return deduped;
}

function deterministicHashInt(input: string): number {
  const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

export function filterByConfidence(
  spans: DetectedSpan[],
  minConfidence: number
): { accepted: DetectedSpan[]; skippedCount: number } {
  const accepted: DetectedSpan[] = [];
  let skippedCount = 0;
  for (const span of spans) {
    if (span.confidence > minConfidence) {
      accepted.push(span);
    } else {
      skippedCount++;
    }
  }
  return { accepted, skippedCount };
}

function makeLuhnSin(originalText: string): string {
  const digits = [9];
  for (let i = 0; i < 7; i++) {
    digits.push(faker.number.int({ min: 0, max: 9 }));
  }
  let checksum = 0;
  for (let idx = 0; idx < digits.length; idx++) {
    let d = digits[idx];
    if (idx % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    checksum += d;
  }
  const checkDigit = (10 - (checksum % 10)) % 10;
  const full = digits.join('') + String(checkDigit);
  if (originalText.includes(' ')) {
    return `${full.slice(0, 3)} ${full.slice(3, 6)} ${full.slice(6, 9)}`;
  }
  if (originalText.includes('-')) {
    return `${full.slice(0, 3)}-${full.slice(3, 6)}-${full.slice(6, 9)}`;
  }
  return full;
}

function makeLuhnCard(originalText: string): string {
  const digits = [4];
  for (let i = 0; i < 14; i++) {
    digits.push(faker.number.int({ min: 0, max: 9 }));
  }
  let checksum = 0;
  for (let idx = 0; idx < digits.length; idx++) {
    let d = digits[idx];
    if (idx % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    checksum += d;
  }
  const checkDigit = (10 - (checksum % 10)) % 10;
  const full = digits.join('') + String(checkDigit);
  if (originalText.includes('-')) {
    return `${full.slice(0, 4)}-${full.slice(4, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}`;
  }
  if (originalText.includes(' ')) {
    return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)} ${full.slice(12, 16)}`;
  }
  return full;
}

const KNOWN_ID_PREFIXES = /^(LIRA|RRSP|TFSA|RRIF|RESP|RDSP|FHSA|LIF|PRPP|SPP|REER|FERR|CELI|REEE|CRI|FRV|REEI|CELIAPP|RPDB|CRA|FS)-/i;
const CA_AREA_CODES = ['416', '647', '437', '905', '604', '778', '403', '587', '514', '438', '418', '819', '613', '902'];
const CA_INSTITUTIONS = ['001', '002', '003', '004', '006', '010'];

/**
 * Generates a synthetic identifier preserving the exact character classes, length,
 * and separators of `original` (e.g., `123456` -> `591042`, `101134059-18` -> `482910384-62`).
 */
function preserveFormatMock(original: string, keepKnownPrefix = false): string {
  let prefix = '';
  let body = original;

  if (keepKnownPrefix) {
    const match = original.match(KNOWN_ID_PREFIXES);
    if (match) {
      prefix = match[0].toUpperCase();
      body = original.slice(prefix.length);
    }
  }

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch >= '0' && ch <= '9') {
      const minD = i === 0 && ch !== '0' ? 1 : 0;
      out += String(faker.number.int({ min: minD, max: 9 }));
    } else if (ch >= 'A' && ch <= 'Z') {
      out += faker.string.alpha({ length: 1, casing: 'upper' });
    } else if (ch >= 'a' && ch <= 'z') {
      out += faker.string.alpha({ length: 1, casing: 'lower' });
    } else {
      out += ch;
    }
  }

  const combined = prefix + out;
  if (combined === original && body.length > 0) {
    // Ensure mock never accidentally equals original
    const idx = body.search(/\d/);
    if (idx >= 0) {
      const altDigit = String((Number(body[idx]) + 3) % 10);
      return prefix + out.slice(0, idx) + altDigit + out.slice(idx + 1);
    }
  }
  return combined;
}

const FR_MONTH_NAMES = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const EN_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatMockDob(original: string): string {
  const y = faker.number.int({ min: 1955, max: 1998 });
  const m = faker.number.int({ min: 1, max: 12 });
  const d = faker.number.int({ min: 1, max: 28 });
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');

  if (/^\d{4}\/\d{2}\/\d{2}$/.test(original)) return `${y}/${mm}/${dd}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(original)) return `${y}-${mm}-${dd}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(original)) return `${mm}/${dd}/${y}`;
  if (/^\d{2}-\d{2}-\d{4}$/.test(original)) return `${mm}-${dd}-${y}`;
  if (new RegExp(`^\\d{1,2}\\s+${FR_MONTHS}\\s+\\d{4}$`, 'i').test(original)) {
    return `${d} ${FR_MONTH_NAMES[m - 1]} ${y}`;
  }
  if (/^[A-Za-z]+\s+\d{1,2},?\s+\d{4}$/.test(original)) {
    const mon = original.includes(',') ? EN_MONTH_NAMES[m - 1] : EN_MONTH_NAMES[m - 1].slice(0, 3);
    return original.includes(',') ? `${mon} ${d}, ${y}` : `${mon} ${d} ${y}`;
  }
  return `${y}-${mm}-${dd}`;
}

export function generateMockReplacement(
  span: DetectedSpan,
  mode: RedactionMode,
  consistent: boolean,
  seed: number,
  nonce: number
): string {
  if (mode === 'solid_mask') {
    const label = span.ruleLabel ? span.ruleLabel.toUpperCase() : span.entityType;
    return `[REDACTED:${label}]`;
  }

  const key = consistent
    ? `${seed}:${span.entityType}:${span.text.trim().toLowerCase()}`
    : `${seed}:${nonce}:${Date.now()}:${Math.random()}:${span.text}`;

  const itemSeed = deterministicHashInt(key);
  faker.seed(itemSeed);

  if (span.entityType === 'CUSTOM') {
    const tpl = span.mockTemplate?.trim();
    if (tpl) {
      return tpl
        .replace(/#/g, () => String(faker.number.int({ min: 0, max: 9 })))
        .replace(/\?/g, () => faker.string.alpha({ length: 1, casing: 'upper' }));
    }
    return preserveFormatMock(span.text, false);
  }

  switch (span.entityType) {
    case 'PERSON': {
      const mockName = faker.person.fullName();
      const lettersOnly = span.text.replace(/[^a-zA-ZÀ-ÿ]/g, '');
      const isAllCaps = lettersOnly.length > 0 && lettersOnly === lettersOnly.toUpperCase();
      return isAllCaps ? mockName.toUpperCase() : mockName;
    }
    case 'EMAIL': {
      const first = faker.person.firstName().toLowerCase().replace(/[^a-z]/g, '') || 'alex';
      const last = faker.person.lastName().toLowerCase().replace(/[^a-z]/g, '') || 'tremblay';
      return `${first}.${last}@example.ca`;
    }
    case 'PHONE': {
      const a = faker.helpers.arrayElement(CA_AREA_CODES);
      const b = faker.number.int({ min: 200, max: 999 });
      const c = faker.number.int({ min: 1000, max: 9999 });
      if (span.text.startsWith('+1')) return `+1-${a}-${b}-${c}`;
      if (span.text.includes('.')) return `${a}.${b}.${c}`;
      if (span.text.includes('-') && !span.text.includes('(')) return `${a}-${b}-${c}`;
      if (/^\d{10}$/.test(span.text)) return `${a}${b}${c}`;
      return `(${a}) ${b}-${c}`;
    }
    case 'SIN':
      return makeLuhnSin(span.text);
    case 'CREDIT_CARD':
      return makeLuhnCard(span.text);
    case 'CANADIAN_BANK_ACCOUNT': {
      if (/^\d{5}[-\s]\d{3}[-\s]\d{7,12}$/.test(span.text)) {
        const transit = String(faker.number.int({ min: 10000, max: 99999 }));
        const inst = faker.helpers.arrayElement(CA_INSTITUTIONS);
        const acctLen = span.text.split(/[-\s]/)[2]?.length || 7;
        let acct = '';
        for (let i = 0; i < acctLen; i++) acct += String(faker.number.int({ min: 0, max: 9 }));
        const sep = span.text.includes(' ') ? ' ' : '-';
        return `${transit}${sep}${inst}${sep}${acct}`;
      }
      return preserveFormatMock(span.text, true);
    }
    case 'LEGAL_CASE_ID': {
      const bnMatch = span.text.match(/^(\d{9})([ \t]?)(RP|RC|RT|RR|RQ)([ \t]?)(\d{4})$/i);
      if (bnMatch) {
        const bNum = faker.number.int({ min: 100000000, max: 899999999 });
        return `${bNum}${bnMatch[2]}${bnMatch[3].toUpperCase()}${bnMatch[4]}${bnMatch[5]}`;
      }
      return preserveFormatMock(span.text, true);
    }
    case 'DOB':
      return formatMockDob(span.text);
    case 'ADDRESS': {
      const postal = faker.location.zipCode('?#? #?#').toUpperCase().replace(/[^A-Z0-9 ]/g, 'K');
      if (new RegExp(`^${CA_POSTAL_STR}$`).test(span.text.trim())) {
        return postal;
      }
      const num = faker.number.int({ min: 110, max: 8990 });
      const street = faker.location.street();
      if (!span.text.includes(',')) {
        return `${num} ${street}`;
      }
      const city = faker.location.city();
      const prov = faker.location.state({ abbreviated: true });
      return `${num} ${street}, ${city}, ${prov} ${postal}`;
    }
    case 'PASSPORT':
      return preserveFormatMock(span.text, false);
    default:
      return '[MASKED]';
  }
}
