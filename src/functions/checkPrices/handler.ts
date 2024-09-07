import type { ValidatedEventAPIGatewayProxyEvent } from '@libs/api-gateway';
import { formatJSONResponse } from '@libs/api-gateway';
import { middyfy } from '@libs/lambda';

import schema from './schema';
import axios from "axios";
import * as cheerio from "cheerio";
import { OpenAI } from "openai";
const fs = require("fs");
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { createObjectCsvWriter } from 'csv-writer';
import * as AWS from 'aws-sdk';
import { promisify } from 'util';
import * as path from 'path';

require("dotenv").config();

console.log("process.env.OPENAI_API_KEY", process.env.OPENAI_API_KEY);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define the schema using Zod
const ServiceSchema = z.object({
  name: z.string(),
  price: z.number(),
  oldPrice: z.number().optional(),
});

const ServicesSchema = z.object({ services: z.array(ServiceSchema) });

const fetchHTML = async (url: string): Promise<string> => {
  const response = await axios.get(url);
  return response.data;
};

const extractLinks = (html: string, domain: string): string[] => {
  const $ = cheerio.load(html);
  const links: string[] = [];
  const seenLinks = new Set<string>();

  $("a").each((index, element) => {
    let link = $(element).attr("href");
    if (link) {
      link = link.replace(new RegExp(`^${domain}`), "");
      const topLevelLink = link.split("/")[1];
      if (!seenLinks.has(topLevelLink)) {
        links.push(link);
        seenLinks.add(topLevelLink);
      }
    }
  });

  return links;
};

const findPricingPageLink = async (
  links: string[]
): Promise<string> => {
  const prompt = `1) Given a list of URLs: ${links.join(
    ", "
  )}, analyze each link to determine if it points to a webpage related to pricing information. The page might use the term "prices" or its equivalent in different languages, such as "precios," "tarifs", "ceny," "kosten," etc.
  2) Return only the single link that points to a pricing page.
  3) If none of the links point to a pricing page, return an empty string ''.
  4) Do this without any additional explanation or formatting—only the link or an empty string should be returned.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || "";
};

const identifyMainBlock = async (html: string): Promise<string> => {
  const chunkSize = 5000;
  const overlapSize = 500;
  const chunks: string[] = [];

  for (let i = 0; i < html.length; i += chunkSize) {
    chunks.push(html.substring(i, i + chunkSize));
  }
  let mainBlock = "";
  console.log("chunks", chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const previousChunk = i > 0 ? chunks[i - 1].slice(-overlapSize) : "";
    
    const chunkPrompt = `You are an intelligent model tasked with parsing a web page in chunks of 5000 characters. Your goal is to identify the main HTML element that contains a list of services related to cosmetic surgery, dermatology, or similar medical services along with their prices in Russian rubles.

		### Instructions:
		1. **Identify Relevant Elements**: In each chunk of text, search for elements that mention the name of a service and a corresponding price in rubles. If you find more than five services with prices, stop and proceed to the next step.

		2. **Trace Back to the Parent Element**: Once a service and its price are identified, trace back through the HTML hierarchy to locate the main container element (such as <div>, <section>, or similar) that encapsulates all the services and their prices.

		3. **Determine the Main Block**: Continue this process until you can confidently determine the main block that contains all relevant price listings for services. The main block must include more than five services with their prices.

		4. **Ensure the Service has a Price**: Only consider services that have an associated price. Skip unrelated sections, links, decorative elements, and any services that don't list a price. Avoid selecting list elements like <li>, <ul>, columns, or other elements which can't be as the main block.

		### Output:
		Before sending a result provide a short reasoning of your decision.

		### Not found Example:
			**Reasoning:**
		After reviewing the chunk, it consists primarily of links and lists of various medical services without prices. None of the elements seem to reference the price in Russian rubles for any of the services listed.
		**No Relevant Block**
		
		### Success Example:
		**Reasoning:**
		In this chunk, I've identified a list of services that are consistently paired with their respective prices. After tracing the HTML structure, it's clear that these services are all grouped within a parent container that effectively encapsulates all the relevant information. This container appears to be the main block that holds the complete list of services and their associated prices.
		**Main Block**
		html
		<div|main|section class="prices">

		- **Important Note**: If all conditions are met, return the HTML element of the **Main Block** with its attributes (e.g., <div|section|main class="example">). Do not return the content of the block, just the element and its attributes.


		Context for processing:
		- Previous chunk: ${previousChunk}
		- Current chunk: ${chunks[i]}`;

    //Provide explanation of the element you are returning.

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: chunkPrompt },
      ],
    });

    const result = completion.choices[0]?.message?.content?.trim();
    // console.log('result', result);

    if (result && result.includes("**Main Block**")) {
      const mainBlockMatch = result.match(/<([a-zA-Z][a-zA-Z0-9]*)[^>]*>/);
      if (mainBlockMatch) {
        mainBlock = mainBlockMatch[0];
        break;
      }
    }
  }

  return mainBlock;
};

const cleanMainBlockHTMLContent = (html: string, mainBlock: string): string => {
  const $ = cheerio.load(html);
  let mainBlockElement = $(mainBlock);
  const tagMatch = mainBlock.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
  const attributesMatch = mainBlock.match(/([a-zA-Z-]+)="([^"]*)"/g);

  if (tagMatch) {
    const tag = tagMatch[1];
    let selector = tag;

    if (attributesMatch) {
      attributesMatch.forEach((attr) => {
        const [key, value] = attr.split("=");
        const cleanValue = value.replace(/"/g, "");
        selector += `[${key}*="${cleanValue}"]`;
      });
    }
    console.log("selector", selector);
    mainBlockElement = $(selector);
  }

  mainBlockElement.find("script, style").remove();
  mainBlockElement.find("[class]").removeAttr("class");
  mainBlockElement.find("[style]").removeAttr("style");
  mainBlockElement.find("[href]").removeAttr("href");

  // Format the HTML content by removing extra spaces and ensuring proper indentation
  const formattedHTML = mainBlockElement
    .text()
    .replace(/\n\s*/g, " ") // Remove leading spaces from each line
    .replace(/\s*\n/g, " ") // Remove trailing spaces from each line
    .replace(/\n{2,}/g, " ") // Replace multiple newlines with a single newline
    .replace(/\t/g, "") // Remove tab characters
    .trim(); // Remove leading and trailing spaces

  return formattedHTML;
};

const splitIntoChunks = (
  content: string,
  chunkSize: number
): string[] => {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.substring(i, i + chunkSize));
  }
  return chunks;
};

const extractServicesFromChunks = async (
  chunks: string[],
  overlapSize: number
): Promise<any[]> => {
  const services: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const previousChunk = i > 0 ? chunks[i - 1].slice(-overlapSize) : "";
    const previousChunkServices = i > 0 ? services.slice(-10) : [];
    const chunkPrompt = `You are a data extraction specialist tasked with extracting information about services and their prices from HTML content. A "service" refers to any procedure or treatment offered by a beauty clinic, dental clinic, cosmetic surgery clinic, or any related service that involves the body.

    ### Instructions:
    1. **Extract Services and Prices**: Identify any service mentioned in the HTML content and extract its name and price. If the service includes information about the time required for the procedure, concatenate this time with the service name.
    2. **Handling Time Columns**: The time for a procedure may be mentioned in a column labeled "Time" or other variations, including Russian equivalents such as "Время" or "Длительность". Ensure to identify these and correctly concatenate the time information with the service name.
    3. **Discounts and Old Prices**: If a service mentions a discount or lists two prices, identify the lower price as the "price" and the higher price as "oldPrice." Ensure to extract both if available.
    4. **Contextualize Across Chunks**: Use the information from the current and previous chunks to ensure all services and prices are accurately captured, even if they are spread across chunks.

    Process each chunk in sequence, combining information from previous chunks where needed to ensure all details are captured.

    previous chunk: ${previousChunk}
    previous chunk services: ${previousChunkServices}
    current chunk: ${chunks[i]}`;

    const chunkCompletion = await openai.beta.chat.completions.parse({
      model: "gpt-4o-2024-08-06",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that should return an array of services and their prices from the following HTML content.",
        },
        { role: "user", content: chunkPrompt },
      ],
      response_format: zodResponseFormat(ServicesSchema, "services"),
    });

    if (chunkCompletion.choices[0].message.parsed?.services) {
      console.log('chunkCompletion.choices[0].message.parsed.services',chunkCompletion.choices[0].message.parsed.services);
      services.push(...chunkCompletion.choices[0].message.parsed.services);
    }
  }
  return services;
};

const saveServicesToCSV = async (services: any[], filePath: string) => {
  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: [
      { id: 'name', title: 'Name' },
      { id: 'price', title: 'Price' },
      { id: 'oldPrice', title: 'Old Price' },
    ],
  });

  await csvWriter.writeRecords(services);
};

const uploadFileToS3 = async (filePath: string, bucketName: string, key: string): Promise<string> => {
  const s3 = new AWS.S3();
  const fileContent = await promisify(fs.readFile)(filePath);

  const params = {
    Bucket: bucketName,
    Key: key,
    Body: fileContent,
  };

  await s3.upload(params).promise();

  return `https://${bucketName}.s3.amazonaws.com/${key}`;
};

export const handler: ValidatedEventAPIGatewayProxyEvent<typeof schema> = async (event) => {
  const url = event.body.url;
  console.log("url", url);

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "URL parameter is required" }),
    };
  }

  try {
    const html = await fetchHTML(url);
    const domain = new URL(url).origin;
    const links = extractLinks(html, domain);
    console.log("links", links);

    const link = await findPricingPageLink(links);
    console.log("link", link);
    let s3Link = '';
    if (link) {
      const fullLink = `${domain}${link}`;
      const pageContent = await fetchHTML(fullLink);
      const mainBlock = await identifyMainBlock(pageContent);
      console.log('mainBlock',mainBlock);
      const cleanedContent = cleanMainBlockHTMLContent(pageContent, mainBlock);
      console.log('Body content length:', cleanedContent.length);

      // const chunkSize = 2000;
      // const overlapSize = 300;
      // const chunks = splitIntoChunks(cleanedContent, chunkSize);
      // const services = await extractServicesFromChunks(chunks, overlapSize);
      // console.log('all services', services);

      // const services = [
      //   {
      //     name: 'Прием (осмотр, консультация) врача - дерматовенеролога, Главного врача первичный',
      //     price: 2500,
      //     oldPrice: 2500
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача дерматовенеролога, врача косметолога с диагностикой',
      //     price: 2000,
      //     oldPrice: 2000
      //   },
      //   {
      //     name: 'Краткий повторный осмотр врача дерматовенеролога, врача косметолога',
      //     price: 1000,
      //     oldPrice: 1000
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача-диетолога первичный',
      //     price: 6000,
      //     oldPrice: 6000
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача-диетолога повторный',
      //     price: 4000,
      //     oldPrice: 4000
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача эндокринолога первичный',
      //     price: 7300,
      //     oldPrice: 7300
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача эндокринолога повторный',
      //     price: 7300,
      //     oldPrice: 7300
      //   },
      //   {
      //     name: 'Первичный прием трихолога-дерматолога без компьютерной диагностики',
      //     price: 1500,
      //     oldPrice: 1500
      //   },
      //   {
      //     name: 'Измерение состава тела (биоимпедансометрия на аппарате "Медасс")',
      //     price: 2000,
      //     oldPrice: 2000
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача мануальной терапии первичный',
      //     price: 7000,
      //     oldPrice: 7000
      //   },
      //   {
      //     name: 'Прием (осмотр, консультация) врача мануальной терапии повторный',
      //     price: 5000,
      //     oldPrice: 5000
      //   },
      //   {
      //     name: 'Осмотр (консультация) врача-физиотерапевта',
      //     price: 2000,
      //     oldPrice: 2000
      //   },
      //   {
      //     name: 'MPT Toning Ultraformer 300 линий + функциональная сыворотка 300 линий 60 мин',
      //     price: 30000,
      //     oldPrice: 30000
      //   },
      //   {
      //     name: 'Smas-лифтинг Ultraformer MPT. Лицо полностью 500 линий 60 мин',
      //     price: 50000,
      //     oldPrice: 50000
      //   },
      //   {
      //     name: 'Smas-лифтинг Ultraformer MPT. Лицо + подчелюстная зона. 700 линий 60 мин',
      //     price: 70000,
      //     oldPrice: 70000
      //   }
      // ]

      const domainWithoutLink = new URL(url).hostname.split('.').slice(0, -1).join('.');
      // // Save to CSV
      const csvFilePath = path.join('/tmp', `${domainWithoutLink}-services.csv`);
      // await saveServicesToCSV(services, csvFilePath);

      // // Upload to S3
      // const s3Key = `${domainWithoutLink}-services.csv`;
      // s3Link = await uploadFileToS3(csvFilePath, process.env.S3_BUCKET_UPLOAD_NAME, s3Key);
      // console.log('s3Link',s3Link)

      // const filePath = `${domainWithoutLink}-prices.html`;
      fs.writeFileSync(csvFilePath, JSON.stringify(cleanedContent, null, 2));
    } else {
      console.log("No pricing page link found.");
    }

    return formatJSONResponse({
      message: s3Link,
      event,
    });
  } catch (error) {
    console.error(error);
    return formatJSONResponse({
      message: "An error occurred",
      error: error.message,
    });
  }
};

export const main = middyfy(handler);

