import { createClaudeDriver } from "./brain-claude.ts";

const driver = createClaudeDriver();
const residentId = await driver.createResident("雾灯（虚构演示住户）");

await driver.remember(residentId, "雾灯住在 Mist 的演示房间，喜欢把答案说得简短。");
await driver.commit(residentId, "回答时不假装拥有启动包之外的记忆。");

const reply = await driver.say(residentId, "醒来后只用一句话告诉我：你是谁，以及刚读到的一件事。");

console.log(reply.content);
