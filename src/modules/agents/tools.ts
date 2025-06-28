import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { userService } from '../users/service.js';
import { logger } from '../../utils/logger.js';

/**
 * Defines the schema for updating a user's profile.
 * This ensures that agents can only update specific, allowed fields.
 */
const updateUserSchema = z.object({
  interests: z.array(z.string()).optional().describe("A list of the user's interests, e.g., ['technology', 'movies']."),
  learningGoal: z.string().optional().describe("The user's primary motivation for learning."),
  onboardingStep: z.string().optional().describe("The current step in the user's onboarding process."),
  isOnboarding: z.boolean().optional().describe("Set to false when the onboarding process is complete."),
  cefrLevel: z.string().optional().describe("The user's determined CEFR level, e.g., 'A2' or 'B1'."),
});

/**
 * A tool that allows an agent to read a user's profile from the database.
 * This is a read-only operation.
 */
export const readUserProfileTool = new DynamicStructuredTool({
  name: 'read_user_profile',
  description: "Reads the user's complete profile data from the database. Use this to answer questions about the user's status, level, or preferences.",
  schema: z.object({
    userId: z.string().describe("The UUID of the user whose profile is to be read."),
  }),
  func: async ({ userId }) => {
    try {
      logger.info(`Tool 'read_user_profile' invoked for user: ${userId}`);
      const user = await userService.getUserById(userId);
      if (!user) {
        return `Error: User with ID ${userId} not found.`;
      }
      // Return a stringified JSON of the user profile for the LLM to process
      return JSON.stringify(user);
    } catch (error) {
      logger.error("Error in 'read_user_profile' tool:", error);
      return 'An error occurred while trying to read the user profile.';
    }
  },
});

/**
 * A tool that allows an agent to update a user's profile in the database.
 * This is a write operation and is restricted by the updateUserSchema.
 */
export const updateUserProfileTool = new DynamicStructuredTool({
  name: 'update_user_profile',
  description: "Updates a user's profile in the database. Use this to save information gathered during conversation, such as interests, learning goals, or onboarding completion.",
  schema: z.object({
    userId: z.string().describe("The UUID of the user whose profile is to be updated."),
    updates: updateUserSchema,
  }),
  func: async ({ userId, updates }) => {
    try {
      logger.info(`Tool 'update_user_profile' invoked for user: ${userId}`, { updates });
      const updatedUser = await userService.updateUser(userId, updates);
      return `Successfully updated user profile for ${userId}. New data: ${JSON.stringify(updatedUser)}`;
    } catch (error) {
      logger.error("Error in 'update_user_profile' tool:", error);
      return 'An error occurred while trying to update the user profile.';
    }
  },
});

export const allTools = [readUserProfileTool, updateUserProfileTool];
