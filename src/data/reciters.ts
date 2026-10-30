export interface ReciterData {
  id: number;
  name: string;
  style: string;
}

/**
 * Reciters whose quran.com recordings include word-level timing segments.
 * IDs are quran.com (QDC) reciter IDs. Excluded on purpose: 168 (Minshawi
 * "kids repeat" — each verse is recited twice, so segments double up) and
 * 173 (second Afasy recording under the same name).
 */
export const reciters: ReciterData[] = [
  { id: 7, name: "Mishari Rashid al-Afasy", style: "Murattal" },
  { id: 2, name: "AbdulBaset AbdulSamad", style: "Murattal" },
  { id: 1, name: "AbdulBaset AbdulSamad", style: "Mujawwad" },
  { id: 3, name: "Abdur-Rahman as-Sudais", style: "Murattal" },
  { id: 4, name: "Abu Bakr al-Shatri", style: "Murattal" },
  { id: 5, name: "Hani ar-Rifai", style: "Murattal" },
  { id: 6, name: "Mahmoud Khalil Al-Husary", style: "Murattal" },
  { id: 12, name: "Mahmoud Khalil Al-Husary", style: "Muallim" },
  { id: 9, name: "Mohamed Siddiq al-Minshawi", style: "Murattal" },
  { id: 10, name: "Sa`ud ash-Shuraym", style: "Murattal" },
  { id: 97, name: "Yasser Ad Dussary", style: "Murattal" },
  { id: 161, name: "Khalifah Al Tunaiji", style: "Murattal" },
];

export const DEFAULT_RECITER_ID = 7;
