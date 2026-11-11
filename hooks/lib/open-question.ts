type Question = { question: string };

let answerWaiting: ((text: string) => void) | null = null;

export const answerOpenQuestion = (text: string) => {
  const answer = answerWaiting;
  if (!answer) return false;
  answerWaiting = null;
  answer(text);
  return true;
};

export const answersOf = (questions: readonly Question[], text: string) =>
  Object.fromEntries(
    questions.slice(0, 1).map((asked) => [asked.question, text]),
  );

export async function raceOpenQuestion<T>(
  asked: Promise<T>,
): Promise<{ result: T } | { answer: string }> {
  const answered = new Promise<string>((resolve) => {
    answerWaiting = resolve;
  });
  try {
    return await Promise.race([
      asked.then((result) => ({ result })),
      answered.then((answer) => ({ answer })),
    ]);
  } finally {
    answerWaiting = null;
  }
}
