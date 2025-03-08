import { logger } from "../logger";
import { composePrompt } from "../prompts";
import { parseJSONObjectFromText } from "../prompts";
import { getUserServerRole } from "../roles";
import {
	type Action,
	type ActionExample,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelTypes,
	type State,
} from "../types";

/**
 * Task: Extract selected task and option from user message
 *
 * Available Tasks:
 * {{#each tasks}}
 * Task {{taskId}}: {{name}}
 * Available options:
 * {{#each options}}
 * - {{name}}: {{description}}
 * {{/each}}
 * - ABORT: Cancel this task
 * {{/each}}
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * 1. Review the user's message and identify which task and option they are selecting
 * 2. Match against the available tasks and their options, including ABORT
 * 3. Return the task ID and selected option name exactly as listed above
 * 4. If no clear selection is made, return null for both fields
 *
 * Return in JSON format:
 * ```json
 * {
 *   "taskId": number | null,
 *   "selectedOption": "OPTION_NAME" | null
 * }
 * ```
 *
 * Make sure to include the ```json``` tags around the JSON object.
 */
const optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{#each tasks}}
Task {{taskId}}: {{name}}
Available options:
{{#each options}}
- {{name}}: {{description}}
{{/each}}
- ABORT: Cancel this task

{{/each}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Review the user's message and identify which task and option they are selecting
2. Match against the available tasks and their options, including ABORT
3. Return the task ID and selected option name exactly as listed above
4. If no clear selection is made, return null for both fields

Return in JSON format:
\`\`\`json
{
  "taskId": number | null,
  "selectedOption": "OPTION_NAME" | null
}
\`\`\`

Make sure to include the \`\`\`json\`\`\` tags around the JSON object.`;

/**
 * Represents an action that allows selecting an option for a pending task that has multiple options.
 * @type {Action}
 * @property {string} name - The name of the action
 * @property {string[]} similes - Similar words or phrases for the action
 * @property {string} description - A brief description of the action
 * @property {Function} validate - Asynchronous function to validate the action
 * @property {Function} handler - Asynchronous function to handle the action
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action
 */
export const choiceAction: Action = {
	name: "CHOOSE_OPTION",
	similes: ["SELECT_OPTION", "SELECT", "PICK", "CHOOSE"],
	description: "Selects an option for a pending task that has multiple options",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<boolean> => {
		// Get all tasks with options metadata
		const pendingTasks = await runtime.getDatabaseAdapter().getTasks({
			roomId: message.roomId,
			tags: ["AWAITING_CHOICE"],
		});

		const room =
			state.data.room ??
			(await runtime.getDatabaseAdapter().getRoom(message.roomId));

		const userRole = await getUserServerRole(
			runtime,
			message.entityId,
			room.serverId,
		);

		if (userRole !== "OWNER" && userRole !== "ADMIN") {
			return false;
		}

		// Only validate if there are pending tasks with options
		return (
			pendingTasks &&
			pendingTasks.length > 0 &&
			pendingTasks.some((task) => task.metadata?.options)
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: any,
		callback: HandlerCallback,
		responses: Memory[],
	): Promise<void> => {
		try {
			// Handle initial responses
			for (const response of responses) {
				await callback(response.content);
			}

			const pendingTasks = await runtime.getDatabaseAdapter().getTasks({
				roomId: message.roomId,
				tags: ["AWAITING_CHOICE"],
			});

			if (!pendingTasks?.length) {
				throw new Error("No pending tasks with options found");
			}

			const tasksWithOptions = pendingTasks.filter(
				(task) => task.metadata?.options,
			);

			if (!tasksWithOptions.length) {
				throw new Error("No tasks currently have options to select from.");
			}

			// Format tasks with their options for the LLM
			const formattedTasks = tasksWithOptions.map((task, index) => ({
				taskId: index + 1,
				name: task.name,
				options: task.metadata.options.map((opt) => ({
					name: typeof opt === "string" ? opt : opt.name,
					description:
						typeof opt === "string" ? opt : opt.description || opt.name,
				})),
			}));

			const prompt = composePrompt({
				state: {
					...state,
					tasks: formattedTasks,
					recentMessages: message.content.text,
				},
				template: optionExtractionTemplate,
			});

			const result = await runtime.useModel(ModelTypes.TEXT_SMALL, {
				prompt,
				stopSequences: [],
			});

			const parsed = parseJSONObjectFromText(result);
			const { taskId, selectedOption } = parsed;

			if (taskId && selectedOption) {
				const selectedTask = tasksWithOptions[taskId - 1];

				if (selectedOption === "ABORT") {
					await runtime.getDatabaseAdapter().deleteTask(selectedTask.id);
					await callback({
						text: `Task "${selectedTask.name}" has been cancelled.`,
						actions: ["CHOOSE_OPTION"],
						source: message.content.source,
					});
					return;
				}

				try {
					const taskWorker = runtime.getTaskWorker(selectedTask.name);
					await taskWorker.execute(runtime, { option: selectedOption });
					await runtime.getDatabaseAdapter().deleteTask(selectedTask.id);
					await callback({
						text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
						actions: ["CHOOSE_OPTION"],
						source: message.content.source,
					});
					return;
				} catch (error) {
					logger.error("Error executing task with option:", error);
					await callback({
						text: "There was an error processing your selection.",
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
					return;
				}
			}

			// If no task/option was selected, list available options
			let optionsText =
				"Please select a valid option from one of these tasks:\n\n";
			tasksWithOptions.forEach((task, index) => {
				optionsText += `${index + 1}. **${task.name}**:\n`;
				const options = task.metadata.options.map((opt) =>
					typeof opt === "string" ? opt : opt.name,
				);
				options.push("ABORT");
				optionsText += options.map((opt) => `- ${opt}`).join("\n");
				optionsText += "\n\n";
			});

			await callback({
				text: optionsText,
				actions: ["SELECT_OPTION_INVALID"],
				source: message.content.source,
			});
		} catch (error) {
			logger.error("Error in select option handler:", error);
			await callback({
				text: "There was an error processing the option selection.",
				actions: ["SELECT_OPTION_ERROR"],
				source: message.content.source,
			});
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "post",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Selected option: post for task: Confirm Twitter Post",
					actions: ["CHOOSE_OPTION"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "I choose cancel",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Selected option: cancel for task: Confirm Twitter Post",
					actions: ["CHOOSE_OPTION"],
				},
			},
		],
	] as ActionExample[][],
};

export default choiceAction;
