/**
 * Document processing functions for the docusaurus-plugin-llms plugin
 */

import * as path from 'path';
import matter from 'gray-matter';
import { minimatch } from 'minimatch';
import { DocInfo, PluginContext } from './types';
import {
  readFile,
  extractTitle,
  cleanMarkdownContent,
  applyPathTransformations
} from './utils';

/**
 * Process a markdown file and extract its metadata and content
 * @param filePath - Path to the markdown file
 * @param baseDir - Base directory
 * @param siteUrl - Base URL of the site
 * @param pathPrefix - Path prefix for URLs (e.g., 'docs' or 'blog')
 * @param pathTransformation - Path transformation configuration
 * @returns Processed file data
 */
export async function processMarkdownFile(
  filePath: string,
  baseDir: string,
  siteUrl: string,
  pathPrefix: string = 'docs',
  pathTransformation?: {
    ignorePaths?: string[];
    addPaths?: string[];
  }
): Promise<DocInfo> {
  const content = await readFile(filePath);
  const { data, content: markdownContent } = matter(content);

  const relativePath = path.relative(baseDir, filePath);
  // Convert to URL path format (replace backslashes with forward slashes on Windows)
  const normalizedPath = relativePath.replace(/\\/g, '/');

  // Determine the URL path - prioritize frontmatter slug over file path
  let urlPath: string;

  if (data.slug) {
    // Use the slug from frontmatter, ensuring it doesn't start with /
    urlPath = data.slug.startsWith('/') ? data.slug.slice(1) : data.slug;
  } else {
    // Fall back to file path logic
    // Convert .md extension to appropriate path
    const linkPathBase = normalizedPath.replace(/\.mdx?$/, '');

    // Handle index files specially
    urlPath = linkPathBase.endsWith('index')
      ? linkPathBase.replace(/\/index$/, '')
      : linkPathBase;
  }

  // Apply path transformations to the URL path
  const transformedLinkPath = applyPathTransformations(urlPath, pathTransformation);

  // Also apply path transformations to the pathPrefix if it's not empty
  // This allows removing 'docs' from the path when specified in ignorePaths
  let transformedPathPrefix = pathPrefix;
  if (pathPrefix && pathTransformation?.ignorePaths?.includes(pathPrefix)) {
    transformedPathPrefix = '';
  }

  // Generate full URL with transformed path and path prefix
  const fullUrl = new URL(
    `${transformedPathPrefix ? `${transformedPathPrefix}/` : ''}${transformedLinkPath}`,
    siteUrl
  ).toString();

  // Extract title
  const title = extractTitle(data, markdownContent, filePath);

  // Get description from frontmatter or first paragraph
  let description = '';

  // First priority: Use frontmatter description if available
  if (data.description) {
    description = data.description;
  } else {
    // Second priority: Find the first non-heading paragraph
    const paragraphs = markdownContent.split('\n\n');
    for (const para of paragraphs) {
      const trimmedPara = para.trim();
      // Skip empty paragraphs and headings
      if (trimmedPara && !trimmedPara.startsWith('#')) {
        description = trimmedPara;
        break;
      }
    }

    // Third priority: If still no description, use the first heading's content
    if (!description) {
      const firstHeadingMatch = markdownContent.match(/^#\s+(.*?)$/m);
      if (firstHeadingMatch && firstHeadingMatch[1]) {
        description = firstHeadingMatch[1].trim();
      }
    }
  }

  // Only remove heading markers at the beginning of descriptions or lines
  // This preserves # characters that are part of the content
  if (description) {
    // Original approach had issues with hashtags inside content
    // Fix: Only remove # symbols at the beginning of lines or description
    // that are followed by a space (actual heading markers)
    description = description.replace(/^(#+)\s+/gm, '');

    // Special handling for description frontmatter with heading markers
    if (data.description && data.description.startsWith('#')) {
      // If the description in frontmatter starts with a heading marker,
      // we should preserve it in the extracted description
      description = description.replace(/^#+\s+/, '');
    }

    // Preserve inline hashtags (not heading markers)
    // We don't want to treat hashtags in the middle of content as headings

    // Validate that the description doesn't contain markdown headings
    if (description.match(/^#+\s+/m)) {
      console.warn(`Warning: Description for "${title}" may still contain heading markers`);
    }

    // Warn if the description contains HTML tags
    if (/<[^>]+>/g.test(description)) {
      console.warn(`Warning: Description for "${title}" contains HTML tags`);
    }

    // Warn if the description is very long
    if (description.length > 500) {
      console.warn(`Warning: Description for "${title}" is very long (${description.length} characters)`);
    }
  }

  // Clean and process content
  const cleanedContent = cleanMarkdownContent(markdownContent);

  return {
    title,
    path: normalizedPath,
    url: fullUrl,
    content: cleanedContent,
    description: description || '',
  };
}

/**
 * Process files based on include patterns, ignore patterns, and ordering
 * @param context - Plugin context
 * @param allFiles - All available files
 * @param includePatterns - Patterns for files to include
 * @param ignorePatterns - Patterns for files to ignore
 * @param orderPatterns - Patterns for ordering files
 * @param includeUnmatched - Whether to include unmatched files
 * @returns Processed files
 */
export async function processFilesWithPatterns(
  context: PluginContext,
  allFiles: string[],
  includePatterns: string[] = [],
  ignorePatterns: string[] = [],
  orderPatterns: string[] = [],
  includeUnmatched: boolean = false
): Promise<DocInfo[]> {
  const { siteDir, siteUrl, docsDir } = context;

  // Filter files based on include patterns
  let filteredFiles = allFiles;

  if (includePatterns.length > 0) {
    filteredFiles = allFiles.filter(file => {
      const relativePath = path.relative(siteDir, file);
      return includePatterns.some(pattern =>
        minimatch(relativePath, pattern, { matchBase: true })
      );
    });
  }

  // Apply ignore patterns
  if (ignorePatterns.length > 0) {
    filteredFiles = filteredFiles.filter(file => {
      const relativePath = path.relative(siteDir, file);
      return !ignorePatterns.some(pattern =>
        minimatch(relativePath, pattern, { matchBase: true })
      );
    });
  }

  // Order files according to orderPatterns
  let filesToProcess: string[] = [];

  if (orderPatterns.length > 0) {
    const matchedFiles = new Set<string>();

    // Process files according to orderPatterns
    for (const pattern of orderPatterns) {
      const matchingFiles = filteredFiles.filter(file => {
        const relativePath = path.relative(siteDir, file);
        return minimatch(relativePath, pattern, { matchBase: true }) && !matchedFiles.has(file);
      });

      for (const file of matchingFiles) {
        filesToProcess.push(file);
        matchedFiles.add(file);
      }
    }

    // Add remaining files if includeUnmatched is true
    if (includeUnmatched) {
      const remainingFiles = filteredFiles.filter(file => !matchedFiles.has(file));
      filesToProcess.push(...remainingFiles);
    }
  } else {
    filesToProcess = filteredFiles;
  }

  // Process each file to generate DocInfo
  const processedDocs: DocInfo[] = [];

  for (const filePath of filesToProcess) {
    try {
      // Determine if this is a blog or docs file
      const isBlogFile = filePath.includes(path.join(siteDir, 'blog'));
      const baseDir = isBlogFile ? path.join(siteDir, 'blog') : path.join(siteDir, docsDir);
      const pathPrefix = isBlogFile ? 'blog' : 'docs';

      const docInfo = await processMarkdownFile(
        filePath,
        baseDir,
        siteUrl,
        pathPrefix,
        context.options.pathTransformation
      );
      processedDocs.push(docInfo);
    } catch (err: any) {
      console.warn(`Error processing ${filePath}: ${err.message}`);
    }
  }

  return processedDocs;
} 