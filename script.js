/**
 * ====================================================================
 * Tag格式转换器 - 统一处理算法 + 自定义过滤系统
 * ====================================================================
 * 
 * 功能概述：
 * - 支持Danbooru、Gelbooru、Standard三种格式的智能识别和转换
 * - 采用四阶段处理流程：格式检测 → 内容提取 → 统一清理 → 自定义过滤
 * - 保护词组完整性，防止复合词组被错误分割
 * - 自定义过滤器支持正则表达式和词组过滤
 * - 实时转换，用户体验友好，设置持久化存储
 * - 智能状态管理，包括空输入时的状态重置
 * 
 * 架构设计：
 * - TagConverter: 主控制器类，统筹整个转换流程
 * - FormatDetector: 格式检测模块，智能识别输入格式
 * - ContentExtractor: 内容提取模块，按格式提取有效内容
 * - ContentCleaner: 内容清理模块，标准化和去重处理
 * - FilterManager: 过滤器管理模块，自定义关键词过滤
 * - UIManager: 用户界面管理模块，统一UI交互逻辑
 * - ExampleManager: 示例数据管理，防重复加载和点击冲突
 * 
 * 版本历史：
 * - v1.0: 基础Danbooru格式支持
 * - v2.0: 添加Gelbooru格式支持和统一算法
 * - v3.0: 完整架构重构和现代化UI
 * - v4.0: 自定义过滤器系统
 * - v4.1: 示例管理器和状态重置优化（当前版本）
 */

// ====================================================================
// 常量定义和配置
// ====================================================================

const CONFIG = {
    // 支持的格式类型
    FORMATS: {
        DANBOORU: 'danbooru',    // Danbooru格式：换行符+?标记
        GELBOORU: 'gelbooru',    // Gelbooru格式：Artist?/Tag?连续格式  
        STANDARD: 'standard'     // 标准格式：逗号分隔
    },
    
    // 分类标识符定义
    CATEGORY_MARKERS: ['Artist', 'Character', 'Copyright', 'Tag', 'Metadata', 'General'],
    
    // 正则表达式模式
    PATTERNS: {
        GELBOORU_MARKERS: /(?:Artist|Character|Copyright|Tag|Metadata)\?/i,
        CATEGORY_CONTENT: /^(Artist|Character|Copyright|Metadata|Tag)\s+(.*)$/,
        WEIGHT_REMOVAL: /\s+\d+\.?\d*[kM]?\s*$/,
        GELBOORU_WEIGHT: /\s+\d+\s*(Artist|Character|Copyright|Metadata|Tag)?.*$/,
        NORMALIZE_SPACES: /\s+/g
    },
    
    // UI相关配置
    UI: {
        COPY_SUCCESS_DURATION: 1500,
        COPY_SUCCESS_COLOR: '#34C759',
        DEFAULT_BUTTON_COLOR: '#007AFF'
    },
    
    // 过滤器相关配置
    FILTER: {
        STORAGE_KEY: 'tagConverter_filterSettings',
        DEFAULT_ENABLED: false,
        DEFAULT_KEYWORDS: [],
        DEFAULT_SIMPLIFY_ENABLED: false  // 提示词简化功能默认关闭
    }
};

// ====================================================================
// 过滤器管理模块
// ====================================================================

/**
 * FilterManager - 自定义过滤器管理类
 * 
 * 功能说明：
 * - 管理用户自定义的过滤关键词列表
 * - 支持正则表达式和普通字符串匹配
 * - 提供过滤器启用/禁用控制
 * - 提示词简化：移除被其他提示词完全包含的冗余词汇
 * - 持久化存储用户设置到localStorage
 * - 实时统计过滤效果
 * 
 * 使用场景：
 * - 过滤不需要的tag（如watermark、nsfw等）
 * - 使用正则表达式过滤特定模式（如\d+px）
 * - 过滤包含空格的词组（如bad quality、beautiful girl）
 * - 简化提示词（如移除"hat"当存在"red hat"时）
 * 
 * 技术特点：
 * - 智能正则编译：自动检测并编译正则表达式
 * - 错误容错：无效正则自动转为普通字符串匹配
 * - 性能优化：预编译模式，避免重复解析
 * - 包含检测算法：高效的提示词冗余检测
 * - 数据持久化：localStorage存储，刷新保持设置
 */
class FilterManager {
    constructor() {
        this.enabled = CONFIG.FILTER.DEFAULT_ENABLED;
        this.keywords = [...CONFIG.FILTER.DEFAULT_KEYWORDS];
        this.patterns = [];
        this.lastFilteredCount = 0;
        
        // 提示词简化功能状态
        this.simplifyEnabled = CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
        this.lastSimplifiedCount = 0;
        
        this.loadSettings();
        this.compilePatterns();
    }
    
    /**
     * 加载过滤器设置
     */
    loadSettings() {
        try {
            const saved = localStorage.getItem(CONFIG.FILTER.STORAGE_KEY);
            if (saved) {
                const settings = JSON.parse(saved);
                this.enabled = settings.enabled ?? CONFIG.FILTER.DEFAULT_ENABLED;
                this.keywords = settings.keywords ?? [...CONFIG.FILTER.DEFAULT_KEYWORDS];
                this.simplifyEnabled = settings.simplifyEnabled ?? CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
                this.compilePatterns();
            }
        } catch (error) {
            console.warn('无法加载过滤器设置:', error);
        }
    }
    
    /**
     * 保存过滤器设置
     */
    saveSettings() {
        try {
            const settings = {
                enabled: this.enabled,
                keywords: this.keywords,
                simplifyEnabled: this.simplifyEnabled
            };
            localStorage.setItem(CONFIG.FILTER.STORAGE_KEY, JSON.stringify(settings));
        } catch (error) {
            console.warn('无法保存过滤器设置:', error);
        }
    }
    
    /**
     * 编译正则表达式模式
     * 
     * 处理逻辑：
     * 1. 清空现有模式数组
     * 2. 遍历所有关键词
     * 3. 所有关键词都被视为正则表达式，并确保完全匹配
     * 4. 如果是普通字符串，则自动转义并添加词边界
     * 
     * 特殊处理：
     * - 空关键词自动跳过
     * - 大小写不敏感匹配（'i'标志）
     * - 所有模式都确保完全匹配（使用^$或词边界）
     * - 特殊字符自动转义（对普通字符串）
     */
    compilePatterns() {
        this.patterns = [];
        this.keywords.forEach(keyword => {
            if (!keyword.trim()) return;
            
            const trimmedKeyword = keyword.trim();
            
            try {
                // 检查是否已经包含完全匹配的边界标记
                const hasStartAnchor = trimmedKeyword.startsWith('^');
                const hasEndAnchor = trimmedKeyword.endsWith('$');
                const hasWordBoundary = trimmedKeyword.includes('\\b');
                
                let finalPattern = trimmedKeyword;
                
                // 如果没有任何边界限制，则添加词边界以确保完全匹配
                if (!hasStartAnchor && !hasEndAnchor && !hasWordBoundary) {
                    finalPattern = `^${trimmedKeyword}$`;
                }
                
                // 尝试编译为正则表达式
                const pattern = new RegExp(finalPattern, 'i');
                this.patterns.push(pattern);
            } catch (error) {
                // 正则表达式编译失败，当作普通字符串处理
                // 转义所有正则特殊字符，避免意外匹配
                const escapedKeyword = trimmedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                // 使用^$确保完全匹配，避免误匹配子字符串
                // 例如：过滤"censored"不会误匹配"uncensored"
                this.patterns.push(new RegExp(`^${escapedKeyword}$`, 'i'));
            }
        });
    }
    
    /**
     * 设置启用状态
     * @param {boolean} enabled - 是否启用
     */
    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this.saveSettings();
    }
    
    /**
     * 设置提示词简化功能启用状态
     * @param {boolean} enabled - 是否启用提示词简化
     */
    setSimplifyEnabled(enabled) {
        this.simplifyEnabled = Boolean(enabled);
        this.saveSettings();
    }
    
    /**
     * 设置过滤关键词
     * @param {string} keywordString - 逗号分隔的关键词字符串
     */
    setKeywords(keywordString) {
        this.keywords = keywordString
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0);
        
        this.compilePatterns();
        this.saveSettings();
    }
    
    /**
     * 应用过滤器到tag列表 - 两阶段过滤处理
     * 
     * @param {string[]} tags - 原始tag列表
     * @returns {string[]} - 过滤后的tag列表
     * 
     * 过滤逻辑（按优先级顺序）：
     * 1. 第一阶段：关键词过滤（如启用）
     * 2. 第二阶段：提示词简化（如启用）
     * 3. 统计各阶段过滤的tag数量
     * 
     * 性能考虑：
     * - 未启用时直接跳过对应阶段，避免不必要的处理
     * - 使用Array.filter和some方法实现高效过滤
     * - 一旦匹配到规则立即停止检查（短路逻辑）
     */
    applyFilter(tags) {
        let currentTags = [...tags];
        this.lastFilteredCount = 0;
        this.lastSimplifiedCount = 0;
        
        // 第一阶段：关键词过滤（优先级高）
        if (this.enabled && this.patterns.length > 0) {
            const filtered = currentTags.filter(tag => {
                // 检查tag是否匹配任一过滤规则
                // 使用some方法实现短路逻辑，提高性能
                return !this.patterns.some(pattern => pattern.test(tag));
            });
            
            this.lastFilteredCount = currentTags.length - filtered.length;
            currentTags = filtered;
        }
        
        // 第二阶段：提示词简化（优先级低，依赖主开关）
        if (this.enabled && this.simplifyEnabled) {
            const simplified = this.simplifyTags(currentTags);
            this.lastSimplifiedCount = currentTags.length - simplified.length;
            currentTags = simplified;
        }
        
        return currentTags;
    }
    
    /**
     * 提示词简化算法 - 移除被其他提示词完全包含的冗余词汇
     * 
     * @param {string[]} tags - 输入的tag列表
     * @returns {string[]} - 简化后的tag列表，按首字母排序
     * 
     * 算法原理：
     * 1. 对每个tag，检查是否被其他更长的tag完全包含
     * 2. 如果tag A完全包含在tag B中（作为独立词汇或完整子串），则移除tag A
     * 3. 使用多种包含检测方式确保准确匹配
     * 4. 返回结果按首字母排序
     * 
     * 示例：
     * - 输入：["hat", "red hat", "blue eyes"]
     * - 输出：["blue eyes", "red hat"]  (移除"hat"，按首字母排序)
     * - 输入：["unzen (azur lane)", "unzen (sojourn through clear seas) (azur lane)"]
     * - 输出：["unzen (sojourn through clear seas) (azur lane)"]
     * 
     * 性能优化：
     * - 按长度排序，优先检查较短的词汇
     * - 使用多种匹配方式确保包含检测的准确性
     * - 一旦发现包含关系立即跳过该词汇
     */
    simplifyTags(tags) {
        if (!tags || tags.length <= 1) return tags;
        
        // 创建带索引的标签数组，用于保持原始顺序
        const indexedTags = tags.map((tag, index) => ({ tag, originalIndex: index }));
        const result = [];
        
        for (let i = 0; i < indexedTags.length; i++) {
            const currentItem = indexedTags[i];
            let isContained = false;
            
            // 检查当前tag是否被其他tag包含
            for (let j = 0; j < indexedTags.length; j++) {
                if (i === j) continue; // 跳过自己
                
                const otherItem = indexedTags[j];
                
                if (this.isTagContainedIn(currentItem.tag, otherItem.tag)) {
                    isContained = true;
                    break;
                }
            }
            
            // 如果没有被包含，则保留该tag
            if (!isContained) {
                result.push(currentItem);
            }
        }
        
        // 按原始输入顺序排序返回结果
        return result
            .sort((a, b) => a.originalIndex - b.originalIndex)
            .map(item => item.tag);
    }
    
    /**
     * 检查短tag是否被长tag包含
     * 专门针对提示词的语义包含关系检测
     * 
     * @param {string} shortTag - 较短的tag
     * @param {string} longTag - 较长的tag
     * @returns {boolean} - 是否包含
     */
    isTagContainedIn(shortTag, longTag) {
        // 如果完全相同，不视为包含关系
        if (shortTag.toLowerCase() === longTag.toLowerCase()) {
            return false;
        }
        
        // 如果短tag不短于长tag，不可能包含
        if (shortTag.length >= longTag.length) {
            return false;
        }
        
        const shortTrimmed = shortTag.trim();
        const longTrimmed = longTag.trim();
        const shortLower = shortTrimmed.toLowerCase();
        const longLower = longTrimmed.toLowerCase();
        
        // 方法1：简单词汇的词边界匹配
        // 例如："hat" 包含在 "red hat" 中，但 "censored" 不包含在 "uncensored" 中
        if (this.isSimpleWordContained(shortTrimmed, longTrimmed)) {
            return true;
        }
        
        // 方法2：复杂词组的语义包含检测
        // 例如："unzen (azur lane)" 语义上包含在 "unzen (sojourn through clear seas) (azur lane)" 中
        if (this.isComplexPhraseContained(shortTrimmed, longTrimmed)) {
            return true;
        }
        
        return false;
    }
    
    /**
     * 检查简单词汇的词边界包含
     * @param {string} shortTag - 短标签
     * @param {string} longTag - 长标签  
     * @returns {boolean} - 是否包含
     */
    isSimpleWordContained(shortTag, longTag) {
        try {
            // 使用严格的词边界匹配
            const pattern = new RegExp(`\\b${this.escapeRegex(shortTag)}\\b`, 'i');
            const result = pattern.test(longTag);
            
            // 额外检查：确保不是部分匹配
            // 例如 "censored" 不应该匹配 "uncensored"
            if (result) {
                const shortLower = shortTag.toLowerCase();
                const longLower = longTag.toLowerCase();
                
                // 如果长标签只是在短标签前后加了字符，则不认为是包含
                if (longLower.startsWith(shortLower) || longLower.endsWith(shortLower)) {
                    // 检查是否只是前缀或后缀
                    if (longLower === shortLower) {
                        return false; // 完全相同
                    }
                    
                    // 如果是连续的字母数字组合（如censored/uncensored），则不认为包含
                    const beforeMatch = longLower.indexOf(shortLower);
                    if (beforeMatch >= 0) {
                        const beforeChar = beforeMatch > 0 ? longLower[beforeMatch - 1] : '';
                        const afterChar = beforeMatch + shortLower.length < longLower.length ? 
                                        longLower[beforeMatch + shortLower.length] : '';
                        
                        // 如果前后都是字母数字，则认为是一个连续单词的一部分
                        if (/[a-z0-9]/.test(beforeChar) || /[a-z0-9]/.test(afterChar)) {
                            return false;
                        }
                    }
                }
            }
            
            return result;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * 检查复杂词组的语义包含
     * @param {string} shortTag - 短标签
     * @param {string} longTag - 长标签
     * @returns {boolean} - 是否包含
     */
    isComplexPhraseContained(shortTag, longTag) {
        const shortLower = shortTag.toLowerCase();
        const longLower = longTag.toLowerCase();
        
        // 对于复杂词组，我们需要分析语义结构
        // 例如："unzen (azur lane)" 和 "unzen (sojourn through clear seas) (azur lane)"
        
        // 检查是否有共同的主要部分和修饰部分
        // 分解标签结构：提取主要词汇和括号内容
        const shortParts = this.parseTagStructure(shortTag);
        const longParts = this.parseTagStructure(longTag);
        
        // 如果短标签的所有重要部分都出现在长标签中，则认为包含
        if (shortParts.mainWord && longParts.mainWord) {
            // 主词必须完全匹配
            if (shortParts.mainWord.toLowerCase() !== longParts.mainWord.toLowerCase()) {
                return false;
            }
            
            // 检查括号内容的包含关系
            for (const shortBracket of shortParts.bracketContents) {
                let found = false;
                for (const longBracket of longParts.bracketContents) {
                    if (longBracket.toLowerCase().includes(shortBracket.toLowerCase())) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return false;
                }
            }
            
            return true;
        }
        
        return false;
    }
    
    /**
     * 解析标签结构，提取主要词汇和括号内容
     * @param {string} tag - 标签
     * @returns {Object} - 包含mainWord和bracketContents的对象
     */
    parseTagStructure(tag) {
        const bracketContents = [];
        let cleanTag = tag;
        
        // 提取所有括号内容
        const bracketMatches = tag.matchAll(/\(([^)]+)\)/g);
        for (const match of bracketMatches) {
            bracketContents.push(match[1].trim());
            cleanTag = cleanTag.replace(match[0], '').trim();
        }
        
        // 剩余的就是主要词汇
        const mainWord = cleanTag.trim();
        
        return {
            mainWord,
            bracketContents
        };
    }
    
    /**
     * 转义正则表达式特殊字符
     * @param {string} str - 需要转义的字符串
     * @returns {string} - 转义后的字符串
     */
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    /**
     * 获取过滤器状态信息
     * @returns {Object} 状态信息
     */
    getStatus() {
        return {
            enabled: this.enabled,
            simplifyEnabled: this.simplifyEnabled,
            keywordCount: this.keywords.length,
            lastFilteredCount: this.lastFilteredCount,
            lastSimplifiedCount: this.lastSimplifiedCount,
            keywords: this.keywords
        };
    }
}

// ====================================================================
// 核心处理类：Tag转换器
// ====================================================================

class TagConverter {
    constructor() {
        this.formatDetector = new FormatDetector();
        this.contentExtractor = new ContentExtractor();
        this.contentCleaner = new ContentCleaner();
        this.filterManager = new FilterManager();
        this.uiManager = new UIManager();
    }
    
    /**
     * 主转换方法 - 四阶段处理流程的核心入口
     * 
     * 处理流程：
     * 1. 格式检测：识别输入文本的格式类型（Danbooru/Gelbooru/Standard）
     * 2. 内容提取：根据格式类型提取原始tag内容
     * 3. 内容清理：标准化处理、去重、移除权重等
     * 4. 自定义过滤：应用用户设定的过滤规则
     * 
     * @param {string} input - 输入的原始文本
     * @returns {string[]} - 处理后的tag数组
     * 
     * @throws {Error} 当转换过程中发生错误时抛出异常
     */
    convert(input) {
        if (!input || typeof input !== 'string') {
            return [];
        }
        
        try {
            // 四阶段处理流程
            const format = this.formatDetector.detect(input.trim());
            const rawContent = this.contentExtractor.extract(input.trim(), format);
            const cleanedTags = this.contentCleaner.clean(rawContent);
            const filteredTags = this.filterManager.applyFilter(cleanedTags);
            
            // 更新UI状态
            this.uiManager.updateFormatStatus(format, filteredTags.length);
            this.uiManager.updateFilterStatus(this.filterManager.getStatus());
            
            return filteredTags;
        } catch (error) {
            console.error('转换过程中发生错误:', error);
            this.uiManager.showError('转换失败，请检查输入格式');
            return [];
        }
    }
}

// ====================================================================
// 格式检测模块
// ====================================================================

class FormatDetector {
    /**
     * 检测输入文本的格式类型
     * @param {string} input - 输入文本
     * @returns {string} - 格式类型（danbooru/gelbooru/standard）
     */
    detect(input) {
        const hasNewlines = input.includes('\n');
        const hasGelbooruMarkers = CONFIG.PATTERNS.GELBOORU_MARKERS.test(input);
        const hasQuestionMarks = input.includes('?');
        
        // 格式判断逻辑
        if (!hasNewlines && hasGelbooruMarkers) {
            return CONFIG.FORMATS.GELBOORU;
        }
        
        if (hasNewlines && hasQuestionMarks) {
            return CONFIG.FORMATS.DANBOORU;
        }
        
        if (!hasNewlines && hasQuestionMarks) {
            return CONFIG.FORMATS.GELBOORU; // 单行带?的也被视为Gelbooru
        }
        
        return CONFIG.FORMATS.STANDARD; // 默认为标准格式
    }
}

// ====================================================================
// 内容提取模块
// ====================================================================

class ContentExtractor {
    /**
     * 根据格式类型提取原始内容
     * @param {string} input - 输入文本
     * @param {string} format - 格式类型
     * @returns {string} - 提取的原始内容
     */
    extract(input, format) {
        switch (format) {
            case CONFIG.FORMATS.DANBOORU:
                return this.extractDanbooru(input);
            case CONFIG.FORMATS.GELBOORU:
                return this.extractGelbooru(input);
            case CONFIG.FORMATS.STANDARD:
            default:
                return input; // 标准格式直接返回
        }
    }
    
    /**
     * 提取Danbooru格式内容
     * @param {string} input - Danbooru格式输入
     * @returns {string} - 提取的内容
     */
    extractDanbooru(input) {
        const lines = input.split('\n').map(line => line.trim());
        const contents = [];
        
        for (let i = 0; i < lines.length; i++) {
            // 找到?标记行，提取下一行内容
            if (lines[i] === '?' && i + 1 < lines.length) {
                contents.push(lines[i + 1]);
                i++; // 跳过已处理的下一行
            }
        }
        
        return contents.join(', '); // 用逗号连接保持结构
    }
    
    /**
     * 提取Gelbooru格式内容
     * @param {string} input - Gelbooru格式输入
     * @returns {string} - 提取的内容
     */
    extractGelbooru(input) {
        const segments = input.split('?');
        const processedSegments = [];
        
        for (const segment of segments) {
            const trimmedSegment = segment.trim();
            if (!trimmedSegment) continue;
            
            const processedContent = this.processGelbooruSegment(trimmedSegment);
            if (processedContent) {
                processedSegments.push(processedContent);
            }
        }
        
        return processedSegments.join(', ');
    }
    
    /**
     * 处理单个Gelbooru段落
     * @param {string} segment - 单个段落
     * @returns {string|null} - 处理后的内容或null
     */
    processGelbooruSegment(segment) {
        // 检查是否以分类标识符开头
        const categoryMatch = segment.match(CONFIG.PATTERNS.CATEGORY_CONTENT);
        
        if (categoryMatch) {
            // 提取分类标识符后面的内容
            let content = categoryMatch[2];
            // 移除末尾数字和可能的下一个分类标识符
            content = content.replace(CONFIG.PATTERNS.GELBOORU_WEIGHT, '').trim();
            return content || null;
        } else {
            // 普通内容，移除末尾数字
            const cleaned = segment.replace(/\s+\d+.*$/, '').trim();
            return (cleaned && cleaned.length > 1) ? cleaned : null;
        }
    }
}

// ====================================================================
// 内容清理模块
// ====================================================================

class ContentCleaner {
    /**
     * 清理和标准化内容
     * @param {string} rawText - 原始文本内容
     * @returns {string[]} - 清理后的tag数组
     */
    clean(rawText) {
        if (!rawText) return [];
        
        // 按逗号分割并清理每个片段
        const segments = rawText.split(',').map(segment => segment.trim());
        const cleanedTags = [];
        
        for (const segment of segments) {
            const cleanedTag = this.cleanSingleTag(segment);
            if (cleanedTag) {
                cleanedTags.push(cleanedTag);
            }
        }
        
        return this.removeDuplicates(cleanedTags);
    }
    
    /**
     * 清理单个tag
     * @param {string} tag - 单个tag
     * @returns {string|null} - 清理后的tag或null
     */
    cleanSingleTag(tag) {
        if (!tag) return null;
        
        // 跳过纯分类标识符
        if (this.isPureCategoryWord(tag)) {
            return null;
        }
        
        // 移除末尾的数字权重
        let cleaned = tag.replace(CONFIG.PATTERNS.WEIGHT_REMOVAL, '').trim();
        
        // 标准化空格
        cleaned = cleaned.replace(CONFIG.PATTERNS.NORMALIZE_SPACES, ' ').trim();
        
        // 验证有效性
        return (cleaned && cleaned.length > 0) ? cleaned : null;
    }
    
    /**
     * 检查是否为纯分类标识符
     * @param {string} tag - 待检查的tag
     * @returns {boolean} - 是否为分类标识符
     */
    isPureCategoryWord(tag) {
        return CONFIG.CATEGORY_MARKERS.some(
            word => word.toLowerCase() === tag.toLowerCase()
        );
    }
    
    /**
     * 移除重复的tag
     * @param {string[]} tags - tag数组
     * @returns {string[]} - 去重后的tag数组
     */
    removeDuplicates(tags) {
        const seen = new Set();
        return tags.filter(tag => {
            const lowerTag = tag.toLowerCase();
            if (seen.has(lowerTag)) {
                return false;
            }
            seen.add(lowerTag);
            return true;
        });
    }
}

// ====================================================================
// 用户界面管理模块
// ====================================================================

class UIManager {
    constructor() {
        this.elements = {
            input: document.getElementById('input'),
            output: document.getElementById('output'),
            formatStatus: document.getElementById('format-status'),
            filterEnabled: document.getElementById('filter-enabled'),
            filterKeywords: document.getElementById('filter-keywords'),
            filterCount: document.getElementById('filter-count'),
            filteredCount: document.getElementById('filtered-count'),
            filterExpand: document.getElementById('filter-expand'),
            filterContent: document.getElementById('filter-content'),
            // 提示词简化功能的UI元素
            simplifyEnabled: document.getElementById('simplify-enabled'),
            simplifyToggle: document.getElementById('simplify-toggle'),
            simplifiedCount: document.getElementById('simplified-count')
        };
    }
    
    /**
     * 更新格式状态显示
     * @param {string} format - 检测到的格式
     * @param {number} tagCount - tag数量
     */
    updateFormatStatus(format, tagCount) {
        const statusEl = this.elements.formatStatus;
        if (!statusEl) return;
        
        const formatNames = {
            [CONFIG.FORMATS.DANBOORU]: 'Danbooru',
            [CONFIG.FORMATS.GELBOORU]: 'Gelbooru', 
            [CONFIG.FORMATS.STANDARD]: 'Standard'
        };
        
        statusEl.textContent = `检测格式: ${formatNames[format]}，提取Tags: ${tagCount}个`;
        statusEl.className = 'status-indicator detected';
        statusEl.style.display = 'inline-block';
    }
    
    /**
     * 显示错误信息
     * @param {string} message - 错误信息
     */
    showError(message) {
        const outputEl = this.elements.output;
        if (outputEl) {
            outputEl.textContent = `⚠️ ${message}`;
            outputEl.className = '';
        }
    }
    
    /**
     * 更新输出内容
     * @param {string[]} tags - tag数组
     */
    updateOutput(tags) {
        const outputEl = this.elements.output;
        if (!outputEl) return;
        
        if (tags.length === 0) {
            outputEl.textContent = '等待输入内容进行转换...';
            outputEl.className = '';
        } else {
            outputEl.textContent = tags.join(', ');
            outputEl.className = 'has-content';
        }
    }
    
    /**
     * 显示复制成功反馈
     * @param {HTMLElement} button - 复制按钮元素
     */
    showCopySuccess(button) {
        const originalText = button.textContent;
        const originalColor = button.style.background;
        
        button.textContent = '✅ 已复制';
        button.style.background = CONFIG.UI.COPY_SUCCESS_COLOR;
        
        setTimeout(() => {
            button.textContent = originalText;
            button.style.background = originalColor || CONFIG.UI.DEFAULT_BUTTON_COLOR;
        }, CONFIG.UI.COPY_SUCCESS_DURATION);
    }
    
    /**
     * 更新过滤器状态显示
     * @param {Object} status - 过滤器状态
     */
    updateFilterStatus(status) {
        if (this.elements.filterCount) {
            this.elements.filterCount.textContent = status.keywordCount;
        }
        if (this.elements.filteredCount) {
            this.elements.filteredCount.textContent = status.lastFilteredCount;
        }
        if (this.elements.simplifiedCount) {
            this.elements.simplifiedCount.textContent = status.lastSimplifiedCount;
        }
    }
    
    /**
     * 更新简化开关的启用/禁用状态
     * @param {boolean} mainFilterEnabled - 主过滤器是否启用
     */
    updateSimplifyToggleState(mainFilterEnabled) {
        if (this.elements.simplifyToggle) {
            if (mainFilterEnabled) {
                this.elements.simplifyToggle.classList.remove('disabled');
            } else {
                this.elements.simplifyToggle.classList.add('disabled');
            }
        }
    }
    
    /**
     * 初始化过滤器UI
     * @param {FilterManager} filterManager - 过滤器管理器实例
     */
    initializeFilterUI(filterManager) {
        const status = filterManager.getStatus();
        
        if (this.elements.filterEnabled) {
            this.elements.filterEnabled.checked = status.enabled;
        }
        
        if (this.elements.filterKeywords) {
            this.elements.filterKeywords.value = status.keywords.join(', ');
        }
        
        // 初始化提示词简化功能的UI状态
        if (this.elements.simplifyEnabled) {
            this.elements.simplifyEnabled.checked = status.simplifyEnabled;
        }
        
        // 初始化简化开关的启用状态
        this.updateSimplifyToggleState(status.enabled);
        
        this.updateFilterStatus(status);
    }
}

// ====================================================================
// 全局实例和主要功能函数
// ====================================================================

// 创建全局转换器实例
const tagConverter = new TagConverter();

/**
 * 主转换函数 - 供UI调用的入口函数
 * 
 * 功能说明：
 * - 获取用户输入并调用转换器进行处理
 * - 处理空输入状态，自动隐藏格式状态指示器
 * - 更新输出区域显示转换结果
 * - 提供实时转换体验
 * 
 * 状态管理：
 * - 空输入时：隐藏格式状态，重置输出为默认提示
 * - 有效输入时：显示检测结果，更新转换输出
 */
function convert() {
    const input = document.getElementById('input').value.trim();
    
    // 检查输入是否为空，如果为空则隐藏格式状态
    if (!input) {
        const statusEl = document.getElementById('format-status');
        if (statusEl) {
            statusEl.style.display = 'none';
        }
        tagConverter.uiManager.updateOutput([]);
        return;
    }
    
    const tags = tagConverter.convert(input);
    tagConverter.uiManager.updateOutput(tags);
}

/**
 * 剪贴板权限管理器
 */
const ClipboardManager = {
    // 权限状态缓存
    permissionGranted: false,
    permissionChecked: false,
    
    /**
     * 检查剪贴板权限状态
     * @returns {Promise<boolean>} 是否有权限
     */
    async checkPermission() {
        try {
            // 如果已经检查过且有权限，直接返回
            if (this.permissionChecked && this.permissionGranted) {
                return true;
            }
            
            // 检查Permissions API支持
            if ('permissions' in navigator) {
                const permission = await navigator.permissions.query({ name: 'clipboard-read' });
                
                if (permission.state === 'granted') {
                    this.permissionGranted = true;
                    this.permissionChecked = true;
                    return true;
                } else if (permission.state === 'denied') {
                    this.permissionGranted = false;
                    this.permissionChecked = true;
                    return false;
                }
                // 如果是 'prompt' 状态，需要用户交互
            }
            
            return false;
        } catch (error) {
            console.log('权限检查失败，将通过用户交互获取:', error);
            return false;
        }
    },
    
    /**
     * 请求剪贴板权限（通过实际读取操作）
     * @returns {Promise<boolean>} 是否获得权限
     */
    async requestPermission() {
        try {
            // 尝试读取剪贴板来触发权限请求
            await navigator.clipboard.readText();
            this.permissionGranted = true;
            this.permissionChecked = true;
            return true;
        } catch (error) {
            if (error.name === 'NotAllowedError') {
                this.permissionGranted = false;
                this.permissionChecked = true;
                return false;
            }
            // 其他错误（如空剪贴板）不影响权限状态
            this.permissionGranted = true;
            this.permissionChecked = true;
            return true;
        }
    },
    
    /**
     * 安全地读取剪贴板内容
     * @returns {Promise<string>} 剪贴板内容
     */
    async readClipboard() {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            throw new Error('浏览器不支持剪贴板API');
        }
        
        return await navigator.clipboard.readText();
    },
    
    /**
     * 重置权限状态（用于测试或权限变更时）
     */
    resetPermission() {
        this.permissionGranted = false;
        this.permissionChecked = false;
    }
};

/**
 * 粘贴并复制功能 - 一键完成粘贴、处理、复制流程
 * @param {HTMLElement} button - 触发的按钮元素
 */
async function pasteAndCopy(button) {
    try {
        // 检查剪贴板API支持
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            alert('您的浏览器不支持剪贴板读取功能，请使用较新版本的浏览器');
            return;
        }
        
        // 显示加载状态
        const originalText = button.textContent;
        const originalColor = button.style.background;
        button.textContent = '⏳ 处理中...';
        button.disabled = true;
        
        try {
            // 1. 检查权限状态
            let hasPermission = await ClipboardManager.checkPermission();
            
            // 2. 如果没有权限，尝试请求权限
            if (!hasPermission) {
                button.textContent = '🔐 请求权限...';
                hasPermission = await ClipboardManager.requestPermission();
                
                if (!hasPermission) {
                    throw new Error('权限被拒绝');
                }
            }
            
            // 3. 从剪贴板读取内容
            button.textContent = '📋 读取剪贴板...';
            const clipboardText = await ClipboardManager.readClipboard();
            
            if (!clipboardText || !clipboardText.trim()) {
                throw new Error('剪贴板内容为空');
            }
            
            // 4. 将内容粘贴到输入框
            button.textContent = '📝 处理内容...';
            const inputElement = document.getElementById('input');
            inputElement.value = clipboardText;
            
            // 5. 自动转换内容
            convert();
            
            // 等待一小段时间确保转换完成
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // 6. 检查转换结果
            const output = document.getElementById('output');
            const result = output.textContent.trim();
            
            if (!result || result === '等待输入内容进行转换...') {
                throw new Error('转换结果为空');
            }
            
            // 7. 自动复制转换结果
            button.textContent = '📤 复制结果...';
            await navigator.clipboard.writeText(result);
            
            // 8. 显示成功反馈
            button.textContent = '✅ 完成';
            button.style.background = '#34C759';
            
            // 9. 短暂延迟后恢复按钮状态
            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = originalColor || '';
                button.disabled = false;
            }, 2000);
            
        } catch (error) {
            // 错误处理
            console.error('粘贴并复制失败:', error);
            
            let errorMessage = '操作失败';
            if (error.message.includes('剪贴板内容为空')) {
                errorMessage = '剪贴板内容为空，请先复制一些文本';
            } else if (error.message.includes('转换结果为空')) {
                errorMessage = '输入内容无法转换，请检查格式是否正确';
            } else if (error.message.includes('权限被拒绝')) {
                errorMessage = '剪贴板访问被拒绝。如需使用此功能，请:\n1. 刷新页面重试\n2. 检查浏览器设置中的剪贴板权限\n3. 确保在安全的HTTPS环境中使用';
            } else if (error.name === 'NotAllowedError') {
                errorMessage = '需要授权访问剪贴板。请点击浏览器的允许按钮，授权后将记住您的选择';
                // 重置权限状态，下次可以重新请求
                ClipboardManager.resetPermission();
            } else {
                errorMessage = '操作失败: ' + error.message;
            }
            
            button.textContent = '❌ 失败';
            button.style.background = '#FF3B30';
            alert(errorMessage);
            
            // 恢复按钮状态
            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = originalColor || '';
                button.disabled = false;
            }, 3000);
        }
        
    } catch (error) {
        console.error('粘贴并复制功能初始化失败:', error);
        alert('功能初始化失败，请刷新页面重试');
    }
}

/**
 * 主动请求剪贴板权限（页面加载时调用）
 */
async function initializeClipboardPermission() {
    try {
        // 检查当前权限状态
        await ClipboardManager.checkPermission();
        
        if (ClipboardManager.permissionGranted) {
            console.log('✅ 剪贴板权限已获取');
        } else {
            console.log('ℹ️ 剪贴板权限未获取，首次使用时将请求权限');
        }
    } catch (error) {
        console.log('剪贴板权限初始化失败:', error);
    }
}

/**
 * 复制输出结果到剪贴板
 * @param {HTMLElement} button - 触发的按钮元素
 */
function copyOutput(button) {
    const output = document.getElementById('output');
    const content = output.textContent.trim();
    
    if (!content || content === '等待输入内容进行转换...') {
        alert('没有可复制的内容');
        return;
    }
    
    navigator.clipboard.writeText(content)
        .then(() => {
            tagConverter.uiManager.showCopySuccess(button);
        })
        .catch(err => {
            console.error('复制失败:', err);
            alert('复制失败，请手动选择复制');
        });
}

/**
 * 示例加载管理器 - ExampleManager
 * 
 * 问题解决：
 * 1. 重复点击问题：通过isLoading标志防止快速连续点击
 * 2. 示例重复问题：使用循环顺序加载，防止随机出现重复
 * 3. 用户体验问题：提供加载状态反馈和按钮禁用保护
 * 
 * 技术特点：
 * - 循环索引管理：防止越界和重复
 * - 异步加载机制：使用async/await提供流畅体验
 * - 状态保护：通过时间锁防止并发操作
 * - UI反馈：实时更新按钮状态和文本
 */
const ExampleManager = {
    examples: [
        // Danbooru格式示例
        {
            name: 'Danbooru',
            content: `General\n?\n1boy 1.4M\n?\n1girl 6.1M\n?\noriginal 2.8M`
        },
        // Gelbooru格式示例  
        {
            name: 'Gelbooru',
            content: `Artist? nekotokage 169Character? shirayuki tomoe 939Tag? 1girl 8032615? long hair 5441398? smile 3596391`
        },
        // 标准格式示例
        {
            name: 'Standard',
            content: `masterpiece, best quality, 1girl, long hair, blue eyes, school uniform`
        }
    ],
    currentIndex: -1,
    isLoading: false,
    
    /**
     * 获取下一个示例（循环顺序，避免重复）
     * 
     * 算法说明：
     * - 使用模运算实现循环递增索引
     * - 从-1开始，首次调用时索引变为0
     * - 每次调用都保证返回不同的示例
     * - 循环完成后重新从第一个开始
     * 
     * @returns {Object} 包含name和content的示例对象
     */
    getNextExample() {
        this.currentIndex = (this.currentIndex + 1) % this.examples.length;
        return this.examples[this.currentIndex];
    },
    
    /**
     * 加载示例并防止重复点击
     * 
     * 执行流程：
     * 1. 检查是否正在加载，防止并发访问
     * 2. 设置加载状态和按钮禁用
     * 3. 获取下一个示例数据并更新UI
     * 4. 调用转换函数处理新数据
     * 5. 恰复按钮状态和解除加载锁
     * 
     * 防护机制：
     * - isLoading标志防止并发调用
     * - 按钮禁用防止用户重复点击
     * - try/finally确保状态清理
     * - 延时解除防止意外快速点击
     */
    async loadExample() {
        // 防重复点击
        if (this.isLoading) {
            return;
        }
        
        this.isLoading = true;
        
        try {
            const example = this.getNextExample();
            const inputElement = document.getElementById('input');
            const button = document.getElementById('load-example-btn');
            
            // 更新按钮状态
            if (button) {
                const originalText = button.textContent;
                button.textContent = `☑️ 已加载`;
                button.disabled = true;
                
                // 恢复按钮状态
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 500);
            }
            
            // 加载示例内容
            inputElement.value = example.content;
            convert();
            
            // 显示加载的示例类型
            console.log(`已加载 ${example.name} 格式示例`);
            
        } finally {
            // 500ms后允许下次点击
            setTimeout(() => {
                this.isLoading = false;
            }, 500);
        }
    }
};

/**
 * 加载示例数据（全局函数，供按钮调用）
 */
function loadExample() {
    ExampleManager.loadExample();
}

/**
 * 清空所有内容 - 重置应用状态
 * 
 * 清空操作：
 * 1. 清空输入框内容
 * 2. 重置输出区域为默认提示状态
 * 3. 隐藏格式检测状态指示器
 * 4. 清除所有样式类
 * 
 * 注意：不会清除过滤器设置，保持用户配置
 */
function clearAll() {
    document.getElementById('input').value = '';
    document.getElementById('output').textContent = '等待输入内容进行转换...';
    document.getElementById('output').className = '';
    
    const statusEl = document.getElementById('format-status');
    if (statusEl) {
        statusEl.style.display = 'none';
    }
}

/**
 * 切换过滤器启用状态
 * 
 * 操作流程：
 * 1. 读取用户切换状态
 * 2. 更新FilterManager设置
 * 3. 自动保存到localStorage
 * 4. 重新转换当前内容以应用新设置
 * 
 * 实时更新：确保切换后立即看到效果
 */
function toggleFilter() {
    const enabled = document.getElementById('filter-enabled').checked;
    tagConverter.filterManager.setEnabled(enabled);
    
    // 更新简化开关的启用状态
    tagConverter.uiManager.updateSimplifyToggleState(enabled);
    
    // 重新转换当前内容
    convert();
}

/**
 * 切换提示词简化功能启用状态
 * 
 * 操作流程：
 * 1. 读取用户切换状态
 * 2. 更新FilterManager简化设置
 * 3. 自动保存到localStorage
 * 4. 重新转换当前内容以应用新设置
 * 
 * 功能说明：
 * - 启用后自动移除被其他提示词完全包含的冗余词汇
 * - 优先级低于关键词过滤，在关键词过滤之后执行
 * - 实时更新：确保切换后立即看到效果
 */
function toggleSimplify() {
    // 检查主过滤器是否启用，如果未启用则不允许切换
    if (!tagConverter.filterManager.enabled) {
        // 强制保持关闭状态
        document.getElementById('simplify-enabled').checked = false;
        return;
    }
    
    const enabled = document.getElementById('simplify-enabled').checked;
    tagConverter.filterManager.setSimplifyEnabled(enabled);
    
    // 重新转换当前内容
    convert();
}

/**
 * 更新过滤关键词
 * 
 * 处理流程：
 * 1. 获取用户输入的关键词字符串
 * 2. 解析为关键词数组（逗号分割）
 * 3. 更新FilterManager的关键词列表
 * 4. 重新编译正则表达式模式
 * 5. 保存设置到localStorage
 * 6. 更新UI统计信息
 * 7. 重新转换当前内容
 * 
 * 支持格式：
 * - 逗号分割的普通关键词
 * - 正则表达式模式
 * - 包含空格的词组
 */
function updateFilterKeywords() {
    const keywords = document.getElementById('filter-keywords').value;
    tagConverter.filterManager.setKeywords(keywords);
    
    // 更新UI状态
    tagConverter.uiManager.updateFilterStatus(tagConverter.filterManager.getStatus());
    
    // 重新转换当前内容
    convert();
}

/**
 * 切换过滤器设置区域显示/隐藏
 * 
 * 功能说明：
 * - 控制过滤器配置区域的展开/折叠状态
 * - 提供紧凑的UI布局，默认折叠节省空间
 * - 实时更新按钮文本反映当前状态
 * 
 * 交互逻辑：
 * - 折叠状态：显示"展开设置"
 * - 展开状态：显示"收起设置"
 */
function toggleFilterSection() {
    const content = document.getElementById('filter-content');
    const button = document.getElementById('filter-expand');
    
    if (content.style.display === 'none' || content.style.display === '') {
        content.style.display = 'block';
        button.textContent = '收起设置';
    } else {
        content.style.display = 'none';
        button.textContent = '展开设置';
    }
}

/**
 * 显示关于软件弹窗
 */
function showAboutModal() {
    document.getElementById('aboutModal').style.display = 'block';
}

/**
 * 隐藏关于软件弹窗
 */
function hideAboutModal() {
    document.getElementById('aboutModal').style.display = 'none';
}

// ====================================================================
// 事件监听器和初始化
// ====================================================================

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    // 初始化过滤器UI
    tagConverter.uiManager.initializeFilterUI(tagConverter.filterManager);
    
    // 实时转换监听
    document.getElementById('input').addEventListener('input', convert);
    
    // 初始化剪贴板权限
    initializeClipboardPermission();
    
    // 弹窗事件监听器
    const modal = document.getElementById('aboutModal');
    if (modal) {
        // 点击背景区域关闭弹窗
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                hideAboutModal();
            }
        });
    }
    
    console.log('Tag格式转换器已初始化 - 支持Danbooru/Gelbooru/Standard格式 + 自定义过滤');
});