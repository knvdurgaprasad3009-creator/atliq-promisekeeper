import raw from "./generated/dataset.json";
import key from "../data/answer_key.json";
import type { Dataset } from "./types";

export const dataset = raw as unknown as Dataset;
export const answerKey = key as any;
export const AS_OF = dataset.asOf;

export function getDoc(id: string) {
  return dataset.docs.find((d) => d.id === id);
}
