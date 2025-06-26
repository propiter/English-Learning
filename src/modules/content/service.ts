import prisma from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import { createError } from '../../middleware/errorHandler.js';

export const contentService = {
  async getPrompt(cefrLevel: string, promptType: string, persona: string = 'alex') {
    try {
      // First try to find exact level match
      let prompt = await prisma.prompt.findFirst({
        where: {
          cefrLevel,
          promptType,
          persona,
          isActive: true
        }
      });

      // If no exact match, try 'all' level
      if (!prompt) {
        prompt = await prisma.prompt.findFirst({
          where: {
            cefrLevel: 'all',
            promptType,
            persona,
            isActive: true
          }
        });
      }

      if (!prompt) {
        throw createError(`Prompt not found for level: ${cefrLevel}, type: ${promptType}, persona: ${persona}`, 404);
      }

      return prompt;
    } catch (error) {
      logger.error('Error fetching prompt:', error);
      throw error;
    }
  },

  async getAllPrompts(filters: {
    cefrLevel?: string;
    promptType?: string;
    persona?: string;
    isActive?: boolean;
  } = {}) {
    const prompts = await prisma.prompt.findMany({
      where: {
        ...filters
      },
      orderBy: [
        { cefrLevel: 'asc' },
        { promptType: 'asc' },
        { persona: 'asc' }
      ]
    });

    return prompts;
  },

  async createPrompt(promptData: {
    cefrLevel: string;
    promptType: string;
    persona: string;
    title: string;
    systemMessage: string;
    variables?: string[];
  }) {
    try {
      const prompt = await prisma.prompt.create({
        data: {
          ...promptData,
          variables: promptData.variables || []
        }
      });

      logger.info(`New prompt created: ${prompt.id}`);
      return prompt;
    } catch (error) {
      logger.error('Error creating prompt:', error);
      throw error;
    }
  },

  async updatePrompt(promptId: string, updateData: any) {
    try {
      const prompt = await prisma.prompt.update({
        where: { id: promptId },
        data: {
          ...updateData,
          updatedAt: new Date()
        }
      });

      return prompt;
    } catch (error) {
      logger.error('Error updating prompt:', error);
      throw error;
    }
  },

  async deletePrompt(promptId: string) {
    try {
      await prisma.prompt.delete({
        where: { id: promptId }
      });

      logger.info(`Prompt deleted: ${promptId}`);
    } catch (error) {
      logger.error('Error deleting prompt:', error);
      throw error;
    }
  },

  // Replace variables in prompt with actual values
  processPrompt(promptTemplate: string, variables: { [key: string]: string }): string {
    let processedPrompt = promptTemplate;

    Object.entries(variables).forEach(([key, value]) => {
      const placeholder = `{{${key}}}`;
      processedPrompt = processedPrompt.replace(new RegExp(placeholder, 'g'), value);
    });

    return processedPrompt;
  },

  // Get daily practice topics based on user interests and level
  async getDailyPracticeTopic(cefrLevel: string, interests: string[] = []) {
    const topics = this.getTopicsByLevel(cefrLevel);
    const userTopics = topics.filter(topic => 
      interests.some(interest => topic.categories.includes(interest))
    );

    // If user has no matching interests, use general topics
    const availableTopics = userTopics.length > 0 ? userTopics : topics;
    
    // Return random topic
    return availableTopics[Math.floor(Math.random() * availableTopics.length)];
  },

  private getTopicsByLevel(cefrLevel: string) {
    const topicsByLevel: { [key: string]: any[] } = {
      A0: [
        { title: "Basic Greetings", categories: ["general"], prompt: "Practice saying hello and introducing yourself." },
        { title: "Family Members", categories: ["family"], prompt: "Talk about your family members." },
        { title: "Daily Routine", categories: ["lifestyle"], prompt: "Describe what you do every day." }
      ],
      A1: [
        { title: "Shopping", categories: ["lifestyle"], prompt: "Describe your shopping experience at a store." },
        { title: "Food Preferences", categories: ["food"], prompt: "Talk about your favorite foods and drinks." },
        { title: "Hobbies", categories: ["hobbies"], prompt: "Describe what you like to do in your free time." }
      ],
      A2: [
        { title: "Travel Plans", categories: ["travel"], prompt: "Describe a place you want to visit and why." },
        { title: "Work Experience", categories: ["business", "career"], prompt: "Talk about your job or studies." },
        { title: "Technology Use", categories: ["technology"], prompt: "Describe how technology helps you daily." }
      ],
      B1: [
        { title: "Environmental Issues", categories: ["environment"], prompt: "Discuss an environmental problem and possible solutions." },
        { title: "Cultural Differences", categories: ["culture"], prompt: "Compare cultures you know about." },
        { title: "Future Goals", categories: ["career", "personal"], prompt: "Describe your plans for the next five years." }
      ],
      B2: [
        { title: "Social Media Impact", categories: ["technology", "society"], prompt: "Analyze the effects of social media on society." },
        { title: "Education Systems", categories: ["education"], prompt: "Compare different education approaches." },
        { title: "Health and Wellness", categories: ["health", "lifestyle"], prompt: "Discuss modern health challenges." }
      ],
      C1: [
        { title: "Global Economics", categories: ["business", "politics"], prompt: "Analyze current economic trends and their implications." },
        { title: "Artificial Intelligence", categories: ["technology"], prompt: "Discuss AI's impact on various industries." },
        { title: "Climate Change", categories: ["environment", "politics"], prompt: "Evaluate climate change policies and effectiveness." }
      ],
      C2: [
        { title: "Philosophy of Ethics", categories: ["philosophy"], prompt: "Explore ethical dilemmas in modern society." },
        { title: "Literary Analysis", categories: ["literature", "culture"], prompt: "Analyze themes in contemporary literature." },
        { title: "Scientific Innovation", categories: ["science", "technology"], prompt: "Discuss breakthrough scientific discoveries." }
      ]
    };

    return topicsByLevel[cefrLevel] || topicsByLevel['A1'];
  }
};