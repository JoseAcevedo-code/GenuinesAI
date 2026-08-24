/** Rule-based conversation layer: everything answerable without a live search. */

import { OWNER_NAME } from "../branding.ts";
import { CODING_INTENT, GREETING, findRepeatedPhrase, lastHistoryMessage, type HistoryItem } from "./intent.ts";

const MAX_REPEATS = 20;

/** Handles "repeat that", "what did I say", "say X N times", and echoed prompts. */
export function repetitionResponse(prompt: string, history: HistoryItem[]): string | null {
  if (/^(repeat|say) (that|it|your last (answer|message))( again)?[?!. ]*$/i.test(prompt)) {
    const previous = lastHistoryMessage(history, "assistant");
    return previous?.content || "I don’t have a previous answer to repeat yet.";
  }
  if (/^what did i (just )?say[?!. ]*$/i.test(prompt)) {
    const previous = lastHistoryMessage(history, "user");
    return previous ? `You said: “${previous.content}”` : "You haven’t sent an earlier message in this conversation yet.";
  }

  // The word boundary matters: without it "sayonara" and "echoes" parse as
  // repeat commands and the rest of the word is echoed back.
  const command = prompt.match(/^(?:please\s+)?(?:repeat|say|echo)\b(?:\s+(?:this|after me))?(?:\s+([\s\S]*))?$/i);
  if (command) {
    let remainder = (command[1] ?? "").trim().replace(/^[:,-]\s*/, "");
    if (!remainder) return "Tell me the word or sentence you want me to repeat.";

    let count = 1;
    let countGiven = false;
    const countFirst = remainder.match(/^(\d{1,3})\s+times?\s*[:,-]?\s*(.+)$/i);
    const countLast = remainder.match(/^(.+?)\s+(\d{1,3})\s+times?[.!]*$/i);
    if (countFirst) {
      count = Number(countFirst[1]);
      remainder = countFirst[2].trim();
      countGiven = true;
    } else if (countLast) {
      remainder = countLast[1].trim();
      count = Number(countLast[2]);
      countGiven = true;
    }

    remainder = remainder.replace(/^["“']|["”']$/g, "").trim();
    if (!remainder) return "Tell me the word or sentence you want me to repeat.";
    if (countGiven && count < 1) return "Give me a repeat count of at least 1 and I’ll echo it back.";

    const safeCount = Math.min(count, MAX_REPEATS);
    const repeated = Array.from({ length: safeCount }, () => remainder).join(" ");
    return count > MAX_REPEATS ? `${repeated}\n\nI capped that at ${MAX_REPEATS} repetitions.` : repeated;
  }

  const repeated = findRepeatedPhrase(prompt);
  if (repeated) {
    return `I heard you — “${repeated.phrase}” was repeated ${repeated.count} times. I won’t mistake it for an unrelated search. If you want me to echo the phrase, say “repeat ${repeated.phrase}.”`;
  }
  return null;
}

/** Returns a canned reply for prompts that need no live search, or null. */
export function localResponse(prompt: string, history: HistoryItem[]): string | null {
  const repeat = repetitionResponse(prompt, history);
  if (repeat) return repeat;

  if (GREETING.test(prompt)) {
    return `Hey ${OWNER_NAME} 👋 I’m online. Ask me for current news, have me look up a topic, or tell me what you want to work through.`;
  }
  if (/^(how are you|how's it going|hows it going)[?!. ]*$/i.test(prompt)) {
    return "I’m doing well and ready to help. What are we working on?";
  }
  if (/^(who are you|what are you)[?!. ]*$/i.test(prompt)) {
    return "I’m GenuinesAI. Right now I combine live news and reference search with a rule-based conversation system. A full model connection will make my open-ended reasoning much stronger.";
  }
  if (/^(what (do|can) you (know|do)|what are you capable of|help)[?!. ]*$/i.test(prompt)) {
    return "I can search current news and live references, remember the recent conversation, repeat exact words or sentences, help organize plans, guide coding questions, brainstorm, summarize, and draft text. My open-ended reasoning is still rule-based until a full model API is connected.";
  }
  if (/^(do you (like|love|prefer)|what do you think|what is your opinion)\b/i.test(prompt)) {
    return "I don’t have personal feelings, but I can help you examine the question from different angles. What matters most to you about it?";
  }
  if (/\b(thanks|thank you|appreciate it)\b/i.test(prompt)) {
    return "You’re welcome! If you want, I can keep going or search for the latest information on the topic.";
  }
  if (CODING_INTENT.test(prompt)) {
    if (/^(help me (?:to )?(?:code|with coding)|can you (?:help me )?code|i want to (?:learn to )?code)[?!. ]*$/i.test(prompt)) {
      return "Absolutely. What do you want to build, and which language are you using? If you’re coding on Android, tell me whether you’re using Termux, Acode, or another app.";
    }
    if (/\b(debug|bug|error|fix)\b/i.test(prompt)) {
      return "Send me the code, the exact error message, what you expected, and what happened instead. I’ll help you isolate the problem step by step.";
    }
    return "I can help with that coding task. Tell me the language, what you want the code to do, and paste anything you’ve already written. Without a full model API, I’m best at guiding and diagnosing clearly scoped code problems.";
  }
  if (/^(?:please\s+)?(?:summarize|summarise)\b|\bhelp me (?:summarize|summarise)\b/i.test(prompt)) {
    return "Paste the text you want summarized and I’ll pull out the main point, key details, and any action items.";
  }
  if (/\bbrainstorm\b|^(?:please\s+)?(?:give|help) me (?:some )?ideas\b/i.test(prompt)) {
    return "Absolutely. Tell me the topic, who the ideas are for, and any limits you’re working with. I’ll help you develop a focused set of options.";
  }
  if (/\b(?:help me|can you|could you|please) (?:plan|schedule)\b|\bplan my\b|\bmake (?:me )?a plan\b|\bproductive day\b|\borganize my priorities\b|\bto-?do list\b|\btask list\b/i.test(prompt)) {
    return "Let’s make it concrete. Send me what you need to finish, any fixed commitments, and when you want to stop for the day. I’ll organize it into a realistic schedule.";
  }
  if (/^(?:please\s+)?(?:write|draft|rewrite)\b|\bhelp me (?:write|draft|rewrite)\b/i.test(prompt)) {
    return "I can draft that. Tell me who it’s for, the tone you want, and the main point it needs to communicate.";
  }
  if (/^(explain|teach me)( this| something| a difficult concept)?[?!. ]*$/i.test(prompt)) {
    return "What topic would you like explained? Name the concept and I’ll look up a reliable reference, then make it easier to understand.";
  }
  return null;
}
