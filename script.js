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
        GROUPED_STORAGE_KEY: 'tagConverter_groupedFilterSettings', // 分组版本配置key
        DEFAULT_ENABLED: false,
        DEFAULT_KEYWORDS: [],
        DEFAULT_SIMPLIFY_ENABLED: false,  // 提示词简化功能默认关闭
        SCHEMA_VERSION: 1, // 数据结构版本
        DEFAULT_GROUP_NAME_PREFIX: '组' // 默认组名前缀
    }
};

// ====================================================================
// 过滤器数据结构定义
// ====================================================================

/**
 * 生成UUID
 * @returns {string} UUID字符串
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 过滤组数据结构
 * @typedef {Object} Group
 * @property {string} id - 稳定ID（UUID）
 * @property {string} name - 组名
 * @property {boolean} enabled - 是否启用
 * @property {boolean} collapsed - 折叠状态
 * @property {string[]} keywords - 关键词原始文本数组
 * @property {string} replacement - 替换短语的原始输入
 * @property {Object} meta - 元数据
 * @property {number} meta.currentMatchCount - 当前命中数
 */

/**
 * 过滤器配置数据结构
 * @typedef {Object} FilterConfig
 * @property {boolean} masterEnabled - 自定义过滤器总开关
 * @property {Group[]} groups - 有序数组（执行顺序）
 * @property {number} schemaVersion - Schema 版本
 * @property {boolean} simplifyEnabled - 提示词简化开关
 */

/**
 * 创建默认组
 * @param {string} name - 组名
 * @returns {Group}
 */
function createDefaultGroup(name = '') {
    return {
        id: generateUUID(),
        name: name || `${CONFIG.FILTER.DEFAULT_GROUP_NAME_PREFIX} ${Date.now()}`,
        enabled: true,
        collapsed: true,
        keywords: [],
        replacement: '',
        meta: {
            currentMatchCount: 0
        }
    };
}

// ====================================================================
// 过滤器管理模块
// ====================================================================

/**
 * GroupedFilterManager - 分组过滤器管理类
 * 
 * 功能说明：
 * - 管理多个分组的过滤规则
 * - 支持组的增删改查和拖拽排序
 * - 支持替换短语功能
 * - 支持导入导出配置
 * - 提示词简化功能
 * - 兼容旧版本配置自动迁移
 * 
 * 执行顺序：分组过滤 → 提示词简化
 */
class GroupedFilterManager {
    constructor() {
        // 总开关状态
        this.masterEnabled = CONFIG.FILTER.DEFAULT_ENABLED;
        
        // 分组数据
        this.groups = [];
        
        // 提示词简化功能
        this.simplifyEnabled = CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
        this.lastSimplifiedCount = 0;
        
        // 总体统计
        this.lastTotalFilteredCount = 0;
        
        // 初始化
        this.loadSettings();
    }
    
    // ====================================================================
    // 设置管理
    // ====================================================================
    
    /**
     * 加载设置
     */
    loadSettings() {
        try {
            // 首先尝试加载分组版本配置
            const groupedSettings = localStorage.getItem(CONFIG.FILTER.GROUPED_STORAGE_KEY);
            
            if (groupedSettings) {
                this._loadGroupedSettings(JSON.parse(groupedSettings));
            } else {
                // 尝试从旧版本配置迁移
                this._migrateFromOldSettings();
            }
        } catch (error) {
            console.warn('无法加载过滤器设置:', error);
            // 创建默认组
            this._initializeDefaults();
        }
    }
    
    /**
     * 加载分组版本设置
     * @param {FilterConfig} settings
     */
    _loadGroupedSettings(settings) {
        this.masterEnabled = settings.masterEnabled ?? CONFIG.FILTER.DEFAULT_ENABLED;
        this.simplifyEnabled = settings.simplifyEnabled ?? CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
        
        // 加载组数据，确保字段完整性
        this.groups = (settings.groups || []).map(group => ({
            id: group.id || generateUUID(),
            name: group.name || '未命名组',
            enabled: group.enabled ?? true,
            collapsed: group.collapsed ?? true,
            keywords: group.keywords || [],
            replacement: group.replacement || '',
            meta: {
                currentMatchCount: group.meta?.currentMatchCount ?? 0,
                ...group.meta
            }
        }));
    }
    
    /**
     * 从旧版本配置迁移
     */
    _migrateFromOldSettings() {
        try {
            const oldSettings = localStorage.getItem(CONFIG.FILTER.STORAGE_KEY);
            if (oldSettings) {
                const settings = JSON.parse(oldSettings);
                
                this.masterEnabled = settings.enabled ?? CONFIG.FILTER.DEFAULT_ENABLED;
                this.simplifyEnabled = settings.simplifyEnabled ?? CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
                
                // 如果有旧关键词，创建迁移组
                if (settings.keywords && settings.keywords.length > 0) {
                    const migratedGroup = createDefaultGroup('组 1');
                    migratedGroup.keywords = [...settings.keywords];
                    this.groups = [migratedGroup];
                }
                
                // 保存迁移后的设置
                this.saveSettings();
                
                console.info('已从旧版本配置迁移到分组版本');
            } else {
                this._initializeDefaults();
            }
        } catch (error) {
            console.warn('配置迁移失败:', error);
            this._initializeDefaults();
        }
    }
    
    /**
     * 初始化默认设置
     */
    _initializeDefaults() {
        this.masterEnabled = CONFIG.FILTER.DEFAULT_ENABLED;
        this.simplifyEnabled = CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
        this.groups = [];
    }
    
    /**
     * 保存设置
     */
    saveSettings() {
        try {
            const settings = {
                masterEnabled: this.masterEnabled,
                simplifyEnabled: this.simplifyEnabled,
                groups: this.groups,
                schemaVersion: CONFIG.FILTER.SCHEMA_VERSION,
                exportedAt: new Date().toISOString()
            };
            localStorage.setItem(CONFIG.FILTER.GROUPED_STORAGE_KEY, JSON.stringify(settings));
        } catch (error) {
            console.warn('无法保存过滤器设置:', error);
        }
    }
    
    // ====================================================================
    // 状态管理
    // ====================================================================
    
    /**
     * 获取过滤器状态信息
     * @returns {Object} 状态信息
     */
    getStatus() {
        const totalGroups = this.groups.length;
        const enabledGroups = this.groups.filter(g => g.enabled).length;
        
        return {
            enabled: this.masterEnabled,
            simplifyEnabled: this.simplifyEnabled,
            keywordCount: totalGroups, // 显示组数而不是关键词数
            enabledGroupCount: enabledGroups,
            currentFilteredCount: this.lastTotalFilteredCount,
            currentSimplifiedCount: this.lastSimplifiedCount,
            groups: this.groups
        };
    }
    
    /**
     * 设置总开关状态
     * @param {boolean} enabled
     */
    setMasterEnabled(enabled) {
        this.masterEnabled = Boolean(enabled);
        this.saveSettings();
    }
    
    /**
     * 设置提示词简化功能状态
     * @param {boolean} enabled
     */
    setSimplifyEnabled(enabled) {
        this.simplifyEnabled = Boolean(enabled);
        this.saveSettings();
    }
    
    // ====================================================================
    // 组管理功能
    // ====================================================================
    
    /**
     * 添加新组
     * @param {string} name - 组名，可选
     * @returns {Group} 创建的组对象
     */
    addGroup(name = '') {
        const defaultName = name || `${CONFIG.FILTER.DEFAULT_GROUP_NAME_PREFIX} ${this.groups.length + 1}`;
        const newGroup = createDefaultGroup(defaultName);
        this.groups.push(newGroup);
        this.saveSettings();
        return newGroup;
    }
    
    /**
     * 复制组
     * @param {string} groupId - 要复制的组ID
     * @returns {Group|null} 复制的组对象，如果失败返回null
     */
    duplicateGroup(groupId) {
        const sourceGroup = this.groups.find(g => g.id === groupId);
        if (!sourceGroup) return null;
        
        const duplicatedGroup = {
            ...sourceGroup,
            id: generateUUID(),
            name: `${sourceGroup.name}(副本)`,
            meta: {
                currentMatchCount: 0
            }
        };
        
        // 插入到原组后面
        const sourceIndex = this.groups.findIndex(g => g.id === groupId);
        this.groups.splice(sourceIndex + 1, 0, duplicatedGroup);
        
        this.saveSettings();
        return duplicatedGroup;
    }
    
    /**
     * 删除组
     * @param {string} groupId - 组ID
     * @returns {boolean} 删除是否成功
     */
    deleteGroup(groupId) {
        const index = this.groups.findIndex(g => g.id === groupId);
        if (index === -1) return false;
        
        this.groups.splice(index, 1);
        this.saveSettings();
        return true;
    }
    
    /**
     * 更新组信息
     * @param {string} groupId - 组ID
     * @param {Partial<Group>} updates - 要更新的字段
     * @returns {boolean} 更新是否成功
     */
    updateGroup(groupId, updates) {
        const group = this.groups.find(g => g.id === groupId);
        if (!group) return false;
        
        Object.assign(group, updates);
        this.saveSettings();
        return true;
    }
    
    /**
     * 获取组
     * @param {string} groupId - 组ID
     * @returns {Group|null}
     */
    getGroup(groupId) {
        return this.groups.find(g => g.id === groupId) || null;
    }
    
    /**
     * 重新排序组
     * @param {string[]} groupIds - 新的组ID顺序数组
     */
    reorderGroups(groupIds) {
        const newGroups = [];
        
        // 按新顺序重新排列
        for (const id of groupIds) {
            const group = this.groups.find(g => g.id === id);
            if (group) {
                newGroups.push(group);
            }
        }
        
        // 添加任何遗漏的组
        for (const group of this.groups) {
            if (!newGroups.find(g => g.id === group.id)) {
                newGroups.push(group);
            }
        }
        
        this.groups = newGroups;
        this.saveSettings();
    }
    
    /**
     * 清零组的命中计数
     * @param {string} groupId - 组ID，不传则清零所有组
     */
    clearMatchCounts(groupId = null) {
        if (groupId) {
            const group = this.getGroup(groupId);
            if (group) {
                group.meta.currentMatchCount = 0;
            }
        } else {
            this.groups.forEach(group => {
                group.meta.currentMatchCount = 0;
            });
        }
        this.saveSettings();
    }
    
    // ====================================================================
    // 核心过滤算法
    // ====================================================================
    
    /**
     * 应用分组过滤器
     * @param {string[]} tags - 输入标签数组
     * @returns {string[]} 过滤后的标签数组
     */
    applyFilter(tags) {
        if (!this.masterEnabled) {
            return tags;
        }
        
        let currentTags = [...tags];
        let totalFilteredCount = 0;
        
        // 第一阶段：分组过滤
        for (const group of this.groups) {
            if (!group.enabled || group.keywords.length === 0) {
                group.meta.currentMatchCount = 0;
                continue;
            }
            
            const result = this._applyGroupFilter(currentTags, group);
            currentTags = result.filteredTags;
            group.meta.currentMatchCount = result.matchCount;
            totalFilteredCount += result.matchCount;
        }
        
        this.lastTotalFilteredCount = totalFilteredCount;
        
        // 第二阶段：提示词简化
        if (this.simplifyEnabled) {
            const simplifiedTags = this._simplifyTags(currentTags);
            this.lastSimplifiedCount = currentTags.length - simplifiedTags.length;
            currentTags = simplifiedTags;
        } else {
            this.lastSimplifiedCount = 0;
        }
        
        return currentTags;
    }
    
    /**
     * 应用单个组的过滤规则
     * @param {string[]} tags - 输入标签
     * @param {Group} group - 组配置
     * @returns {{filteredTags: string[], matchCount: number}}
     */
    _applyGroupFilter(tags, group) {
        const patterns = this._compileGroupPatterns(group.keywords);
        const matchedIndices = new Set();
        
        // 查找所有匹配的标签索引
        tags.forEach((tag, index) => {
            for (const pattern of patterns) {
                try {
                    if (pattern.test(tag)) {
                        matchedIndices.add(index);
                        break; // 一个组内任意关键词匹配即可
                    }
                } catch (error) {
                    // 正则表达式执行错误，尝试字符串匹配
                    if (tag.includes(pattern.source || pattern)) {
                        matchedIndices.add(index);
                        break;
                    }
                }
            }
        });
        
        if (matchedIndices.size === 0) {
            return { filteredTags: tags, matchCount: 0 };
        }
        
        // 删除匹配的标签
        let filteredTags = tags.filter((_, index) => !matchedIndices.has(index));
        
        // 处理替换短语
        if (group.replacement && this._isValidReplacement(group.replacement)) {
            const replacementTokens = this._parseReplacementString(group.replacement);
            if (replacementTokens.length > 0) {
                // 插入到首次命中的位置
                const insertPosition = Math.min(...matchedIndices);
                filteredTags.splice(insertPosition, 0, ...replacementTokens);
            }
        }
        
        // 全局去重（保留靠前）
        filteredTags = this._dedupeKeepFirst(filteredTags);
        
        return { 
            filteredTags, 
            matchCount: matchedIndices.size 
        };
    }
    
    /**
     * 编译组关键词为正则表达式模式
     * @param {string[]} keywords - 关键词数组
     * @returns {RegExp[]} 编译后的正则表达式数组
     */
    _compileGroupPatterns(keywords) {
        const patterns = [];
        
        for (const keyword of keywords) {
            if (!keyword.trim()) continue;
            
            try {
                // 尝试作为正则表达式编译
                const pattern = new RegExp(keyword, 'i');
                pattern.test(''); // 测试是否有效
                patterns.push(pattern);
            } catch (error) {
                // 无效正则，转为普通字符串匹配（完全匹配）
                const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                patterns.push(new RegExp(`^${escapedKeyword}$`, 'i'));
            }
        }
        
        return patterns;
    }
    
    /**
     * 验证替换短语格式
     * @param {string} replacement - 替换短语
     * @returns {boolean}
     */
    _isValidReplacement(replacement) {
        if (!replacement.trim()) return true; // 空字符串有效（仅删除）
        
        // 检查是否包含逗号但格式不正确
        if (replacement.includes(',')) {
            // 检查逗号格式：必须严格为 ", " 分隔
            // 1. 不能有 ",(" 或 " ," 这样的格式
            // 2. 逗号前不能有空格，逗号后必须有且只有一个空格
            
            // 检查错误的逗号格式
            if (replacement.match(/\s,|,\s{0}(?!\s)|,\s{2,}/)) {
                return false;
            }
            
            // 进一步验证：分割后重构应该相同，且分割后不应该有空字符串
            const parts = replacement.split(', ');
            if (parts.some(part => !part.trim())) {
                return false;
            }
            
            const reconstructed = parts.join(', ');
            if (reconstructed !== replacement) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * 解析替换短语字符串
     * @param {string} replacement - 替换短语
     * @returns {string[]} 替换标签数组
     */
    _parseReplacementString(replacement) {
        if (!replacement.trim()) return [];
        
        return replacement
            .split(', ')
            .map(token => token.trim())
            .filter(token => token.length > 0);
    }
    
    /**
     * 数组去重（保留靠前）
     * @param {string[]} array - 输入数组
     * @returns {string[]} 去重后的数组
     */
    _dedupeKeepFirst(array) {
        const seen = new Set();
        return array.filter(item => {
            if (seen.has(item)) {
                return false;
            }
            seen.add(item);
            return true;
        });
    }
    
    /**
     * 提示词简化算法
     * @param {string[]} tags - 输入标签数组
     * @returns {string[]} 简化后的标签数组
     */
    _simplifyTags(tags) {
        if (!tags || tags.length <= 1) return tags;
        
        const indexedTags = tags.map((tag, index) => ({ tag, originalIndex: index }));
        const result = [];
        
        for (let i = 0; i < indexedTags.length; i++) {
            const currentItem = indexedTags[i];
            let isContained = false;
            
            // 检查当前标签是否被其他标签完全包含
            for (let j = 0; j < indexedTags.length; j++) {
                if (i === j) continue;
                
                const otherItem = indexedTags[j];
                if (otherItem.tag.includes(currentItem.tag) && otherItem.tag !== currentItem.tag) {
                    isContained = true;
                    break;
                }
            }
            
            if (!isContained) {
                result.push(currentItem);
            }
        }
        
        // 按原始顺序排序并返回标签
        return result
            .sort((a, b) => a.originalIndex - b.originalIndex)
            .map(item => item.tag);
    }
    
    // ====================================================================
    // 导入导出功能
    // ====================================================================
    
    /**
     * 导出配置
     * @returns {string} JSON配置字符串
     */
    exportConfig() {
        const config = {
            masterEnabled: this.masterEnabled,
            simplifyEnabled: this.simplifyEnabled,
            groups: this.groups,
            schemaVersion: CONFIG.FILTER.SCHEMA_VERSION,
            exportedAt: new Date().toISOString()
        };
        
        return JSON.stringify(config, null, 2);
    }
    
    /**
     * 验证导入的配置
     * @param {Object} config - 配置对象
     * @returns {{valid: boolean, error?: string, migratedConfig?: Object}}
     */
    validateImportConfig(config) {
        if (!config || typeof config !== 'object') {
            return { valid: false, error: '配置格式无效' };
        }
        
        // 检查必需字段
        if (typeof config.masterEnabled !== 'boolean') {
            return { valid: false, error: '缺少 masterEnabled 字段' };
        }
        
        if (!Array.isArray(config.groups)) {
            return { valid: false, error: '缺少 groups 字段或格式错误' };
        }
        
        // 验证组数据结构
        for (let i = 0; i < config.groups.length; i++) {
            const group = config.groups[i];
            if (!group.id || typeof group.name !== 'string' || !Array.isArray(group.keywords)) {
                return { valid: false, error: `组 ${i + 1} 数据结构无效` };
            }
        }
        
        // 字段迁移（如果需要）
        const migratedConfig = this._migrateConfigSchema(config);
        
        return { valid: true, migratedConfig };
    }
    
    /**
     * 导入配置
     * @param {string} configJson - JSON配置字符串
     * @param {boolean} append - 是否追加模式，否则覆盖
     * @returns {{success: boolean, error?: string, importedGroups?: number}}
     */
    importConfig(configJson, append = false) {
        try {
            const config = JSON.parse(configJson);
            const validation = this.validateImportConfig(config);
            
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            
            const importConfig = validation.migratedConfig;
            
            if (append) {
                // 追加模式：添加新组，但不改变总开关状态
                const newGroups = importConfig.groups.map(group => ({
                    ...group,
                    id: generateUUID(), // 重新生成ID避免冲突
                    meta: {
                        currentMatchCount: 0
                    }
                }));
                
                this.groups.push(...newGroups);
                
                return { 
                    success: true, 
                    importedGroups: newGroups.length 
                };
            } else {
                // 覆盖模式：完全替换配置
                this.masterEnabled = importConfig.masterEnabled;
                this.simplifyEnabled = importConfig.simplifyEnabled ?? this.simplifyEnabled;
                this.groups = importConfig.groups.map(group => ({
                    ...group,
                    meta: {
                        currentMatchCount: 0,
                        ...group.meta
                    }
                }));
                
                return { 
                    success: true, 
                    importedGroups: this.groups.length 
                };
            }
        } catch (error) {
            return { 
                success: false, 
                error: `JSON解析失败: ${error.message}` 
            };
        } finally {
            this.saveSettings();
        }
    }
    
    /**
     * 配置版本迁移
     * @param {Object} config - 配置对象
     * @returns {Object} 迁移后的配置
     */
    _migrateConfigSchema(config) {
        const migrated = { ...config };
        
        // 确保所有组都有完整的字段
        migrated.groups = config.groups.map(group => ({
            id: group.id || generateUUID(),
            name: group.name || '未命名组',
            enabled: group.enabled ?? true,
            collapsed: group.collapsed ?? true,
            keywords: group.keywords || [],
            replacement: group.replacement || '',
            meta: {
                currentMatchCount: 0,
                ...group.meta
            }
        }));
        
        // 确保有简化开关字段
        if (typeof migrated.simplifyEnabled !== 'boolean') {
            migrated.simplifyEnabled = CONFIG.FILTER.DEFAULT_SIMPLIFY_ENABLED;
        }
        
        return migrated;
    }
    
    /**
     * 获取导入预览信息
     * @param {string} configJson - JSON配置字符串
     * @returns {{valid: boolean, preview?: Object, error?: string}}
     */
    getImportPreview(configJson) {
        try {
            const config = JSON.parse(configJson);
            const validation = this.validateImportConfig(config);
            
            if (!validation.valid) {
                return { valid: false, error: validation.error };
            }
            
            const importConfig = validation.migratedConfig;
            const groupNames = importConfig.groups.map(g => g.name);
            const totalKeywords = importConfig.groups.reduce((sum, g) => sum + g.keywords.length, 0);
            
            return {
                valid: true,
                preview: {
                    masterEnabled: importConfig.masterEnabled,
                    simplifyEnabled: importConfig.simplifyEnabled,
                    groupCount: importConfig.groups.length,
                    groupNames,
                    totalKeywords,
                    schemaVersion: importConfig.schemaVersion,
                    exportedAt: importConfig.exportedAt
                }
            };
        } catch (error) {
            return { 
                valid: false, 
                error: `JSON解析失败: ${error.message}` 
            };
        }
    }
}

/**
 * FilterManager - 自定义过滤器管理类 (旧版本兼容)
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
        this.filterManager = new GroupedFilterManager();
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
            this.elements.filteredCount.textContent = status.currentFilteredCount;
        }
        if (this.elements.simplifiedCount) {
            this.elements.simplifiedCount.textContent = status.currentSimplifiedCount;
        }
        
        // 更新各组的匹配徽章显示
        this.updateGroupMatchBadges(status.groups, status.enabled);
    }
    
    /**
     * 更新所有组的匹配徽章显示
     * @param {Array} groups - 组数据数组
     * @param {boolean} masterEnabled - 主开关是否启用
     */
    updateGroupMatchBadges(groups, masterEnabled) {
        groups.forEach(group => {
            const groupElement = document.querySelector(`[data-group-id="${group.id}"]`);
            if (!groupElement) return;
            
            const matchBadge = groupElement.querySelector('.group-match-badge');
            if (!matchBadge) return;
            
            const count = group.meta?.currentMatchCount ?? 0;
            if (masterEnabled && count > 0) {
                matchBadge.textContent = `•${count}`;
                matchBadge.classList.add('has-matches');
            } else {
                matchBadge.textContent = masterEnabled ? '•0' : '—';
                matchBadge.classList.remove('has-matches');
            }
        });
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
     * 更新组开关的启用/禁用状态
     * @param {boolean} mainFilterEnabled - 主过滤器是否启用
     */
    updateGroupToggleStates(mainFilterEnabled) {
        const groupCards = document.querySelectorAll('.group-card');
        groupCards.forEach(groupCard => {
            const groupToggle = groupCard.querySelector('.group-toggle');
            if (groupToggle) {
                if (mainFilterEnabled) {
                    groupToggle.classList.remove('disabled');
                } else {
                    groupToggle.classList.add('disabled');
                }
            }
        });
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
        
        // 初始化展开/收起按钮状态
        this.initializeExpandButtonState();
        
        // 初始化简化开关和组开关的启用状态
        this.updateSimplifyToggleState(status.enabled);
        this.updateGroupToggleStates(status.enabled);
        
        this.updateFilterStatus(status);
    }
    
    /**
     * 初始化展开/收起按钮的状态
     */
    initializeExpandButtonState() {
        const content = document.getElementById('filter-content');
        const button = document.getElementById('filter-expand');
        
        if (content && button) {
            // 根据当前内容显示状态设置按钮文本
            if (content.style.display === 'none' || content.style.display === '') {
                button.textContent = '▼ 展开设置';
            } else {
                button.textContent = '▲ 收起设置';
            }
        }
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
        
        // 重置所有组的命中计数和总体统计
        tagConverter.filterManager.groups.forEach(group => {
            group.meta.currentMatchCount = 0;
        });
        tagConverter.filterManager.lastTotalFilteredCount = 0;
        tagConverter.filterManager.lastSimplifiedCount = 0;
        
        // 更新UI显示
        tagConverter.uiManager.updateOutput([]);
        tagConverter.uiManager.updateFilterStatus(tagConverter.filterManager.getStatus());
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
    tagConverter.filterManager.setMasterEnabled(enabled);
    
    // 更新UI状态和简化开关的启用状态
    tagConverter.uiManager.updateSimplifyToggleState(enabled);
    tagConverter.uiManager.updateGroupToggleStates(enabled);
    tagConverter.uiManager.updateFilterStatus(tagConverter.filterManager.getStatus());
    
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
 * - 折叠状态：显示"▼ 展开设置"
 * - 展开状态：显示"▲ 收起设置"
 */
function toggleFilterSection() {
    const content = document.getElementById('filter-content');
    const button = document.getElementById('filter-expand');
    
    if (content.style.display === 'none' || content.style.display === '') {
        content.style.display = 'block';
        button.textContent = '▲ 收起设置';
    } else {
        content.style.display = 'none';
        button.textContent = '▼ 展开设置';
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
    
    // 初始化分组过滤器UI
    initializeGroupedFilterUI();
    
    console.log('Tag格式转换器已初始化 - 支持分组过滤器版本');
});

// ====================================================================
// 分组过滤器UI交互函数
// ====================================================================

/**
 * 初始化分组过滤器UI
 */
function initializeGroupedFilterUI() {
    const filterManager = tagConverter.filterManager;
    const status = filterManager.getStatus();
    
    // 设置总开关状态
    const filterEnabled = document.getElementById('filter-enabled');
    if (filterEnabled) {
        filterEnabled.checked = status.enabled;
    }
    
    // 设置简化开关状态
    const simplifyEnabled = document.getElementById('simplify-enabled');
    if (simplifyEnabled) {
        simplifyEnabled.checked = status.simplifyEnabled;
    }
    
    // 渲染所有组
    renderAllGroups();
    
    // 更新统计信息
    updateFilterStats();
    
    // 更新空状态显示
    updateEmptyState();
}

/**
 * 渲染所有组
 */
function renderAllGroups() {
    const groupsContainer = document.getElementById('filter-groups');
    if (!groupsContainer) return;
    
    groupsContainer.innerHTML = '';
    
    const groups = tagConverter.filterManager.groups;
    groups.forEach(group => {
        const groupElement = createGroupElement(group);
        groupsContainer.appendChild(groupElement);
    });
    
    // 重新初始化拖拽功能
    addDragListeners();
}

/**
 * 创建组DOM元素
 * @param {Group} group - 组数据
 * @returns {HTMLElement}
 */
function createGroupElement(group) {
    const template = document.getElementById('group-card-template');
    if (!template) {
        console.error('Group template not found');
        return document.createElement('div');
    }
    
    const groupElement = template.content.cloneNode(true).firstElementChild;
    groupElement.setAttribute('data-group-id', group.id);
    
    // 设置组名
    const nameInput = groupElement.querySelector('.group-name');
    if (nameInput) {
        nameInput.value = group.name;
    }
    
    // 设置启用状态
    const enabledCheckbox = groupElement.querySelector('.group-enabled');
    if (enabledCheckbox) {
        enabledCheckbox.checked = group.enabled;
    }
    
    // 设置命中徽标
    const matchBadge = groupElement.querySelector('.group-match-badge');
    if (matchBadge) {
        const count = group.meta?.currentMatchCount ?? 0;
        if (tagConverter.filterManager.masterEnabled && count > 0) {
            matchBadge.textContent = `•${count}`;
            matchBadge.classList.add('has-matches');
        } else {
            matchBadge.textContent = tagConverter.filterManager.masterEnabled ? '•0' : '—';
            matchBadge.classList.remove('has-matches');
        }
    }
    
    // 设置折叠状态
    const expandBtn = groupElement.querySelector('.expand-group-btn');
    const groupContent = groupElement.querySelector('.group-content');
    if (expandBtn && groupContent) {
        if (group.collapsed) {
            expandBtn.setAttribute('aria-expanded', 'false');
            groupContent.style.display = 'none';
        } else {
            expandBtn.setAttribute('aria-expanded', 'true');
            groupContent.style.display = 'block';
        }
    }
    
    // 渲染关键词标签
    renderGroupKeywords(groupElement, group);
    
    // 设置替换短语
    const replacementInput = groupElement.querySelector('.replacement-input');
    if (replacementInput) {
        replacementInput.value = group.replacement;
        validateReplacementInput(replacementInput);
    }
    
    // 设置组开关的禁用状态（基于主过滤器状态）
    const groupToggle = groupElement.querySelector('.group-toggle');
    if (groupToggle) {
        if (tagConverter.filterManager.masterEnabled) {
            groupToggle.classList.remove('disabled');
        } else {
            groupToggle.classList.add('disabled');
        }
    }
    
    return groupElement;
}

/**
 * 渲染组的关键词标签
 * @param {HTMLElement} groupElement - 组DOM元素
 * @param {Group} group - 组数据
 */
function renderGroupKeywords(groupElement, group) {
    const keywordsContainer = groupElement.querySelector('.keywords-tags-display');
    if (!keywordsContainer) return;
    
    keywordsContainer.innerHTML = '';
    
    group.keywords.forEach((keyword, index) => {
        const tag = document.createElement('span');
        tag.className = 'keyword-tag';
        tag.innerHTML = `
            ${keyword}
            <button class="remove-tag" onclick="removeKeywordFromGroup('${group.id}', ${index})" title="删除关键词">×</button>
        `;
        keywordsContainer.appendChild(tag);
    });
}

/**
 * 更新过滤器统计信息
 */
function updateFilterStats() {
    const status = tagConverter.filterManager.getStatus();
    
    const filterCount = document.getElementById('filter-count');
    if (filterCount) {
        filterCount.textContent = status.keywordCount;
    }
    
    const filteredCount = document.getElementById('filtered-count');
    if (filteredCount) {
        filteredCount.textContent = status.currentFilteredCount;
    }
    
    const simplifiedCount = document.getElementById('simplified-count');
    if (simplifiedCount) {
        simplifiedCount.textContent = status.currentSimplifiedCount;
    }
}

/**
 * 更新空状态显示
 */
function updateEmptyState() {
    const emptyState = document.getElementById('empty-state');
    const groupsContainer = document.getElementById('filter-groups');
    
    if (emptyState && groupsContainer) {
        if (tagConverter.filterManager.groups.length === 0) {
            emptyState.style.display = 'block';
            groupsContainer.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
            groupsContainer.style.display = 'block';
        }
    }
}

/**
 * 添加新组
 */
function addGroup() {
    // 如果过滤器区域是折叠状态，先展开
    const content = document.getElementById('filter-content');
    const expandButton = document.getElementById('filter-expand');
    
    if (content && (content.style.display === 'none' || content.style.display === '')) {
        // 展开过滤器区域
        content.style.display = 'block';
        if (expandButton) {
            expandButton.textContent = '▲ 收起设置';
        }
    }
    
    const newGroup = tagConverter.filterManager.addGroup();
    renderAllGroups();
    updateFilterStats();
    updateEmptyState();
    
    // 自动展开新创建的组
    setTimeout(() => {
        const groupElement = document.querySelector(`[data-group-id="${newGroup.id}"]`);
        if (groupElement) {
            const expandBtn = groupElement.querySelector('.expand-group-btn');
            if (expandBtn) {
                toggleGroupExpand(expandBtn);
                // toggleGroupExpand会自动聚焦到关键词输入框，符合用户期望
            }
        }
    }, 100);
}

/**
 * 切换组启用状态
 * @param {HTMLInputElement} checkbox - 复选框元素
 */
function toggleGroup(checkbox) {
    const groupElement = checkbox.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    
    if (groupId) {
        tagConverter.filterManager.updateGroup(groupId, { 
            enabled: checkbox.checked 
        });
        
        // 重新转换
        convert();
        updateFilterStats();
    }
}

/**
 * 更新组名
 * @param {HTMLInputElement} input - 输入框元素
 */
function updateGroupName(input) {
    const groupElement = input.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    
    if (groupId) {
        tagConverter.filterManager.updateGroup(groupId, { 
            name: input.value || '未命名组'
        });
    }
}

/**
 * 保存组名（失焦时调用）
 * @param {HTMLInputElement} input - 输入框元素
 */
function saveGroupName(input) {
    updateGroupName(input);
}

/**
 * 切换组展开/折叠状态
 * @param {HTMLElement} button - 按钮元素
 */
function toggleGroupExpand(button) {
    const groupElement = button.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    const groupContent = groupElement?.querySelector('.group-content');
    const expandButton = groupElement?.querySelector('.expand-group-btn');
    
    if (!groupElement || !groupId || !groupContent || !expandButton) return;
    
    // 基于内容可见性判断当前状态，而不是依赖按钮属性
    const isExpanded = groupContent.style.display === 'block';
    const newExpanded = !isExpanded;
    
    // 同步更新展开按钮的aria-expanded属性
    expandButton.setAttribute('aria-expanded', newExpanded);
    groupContent.style.display = newExpanded ? 'block' : 'none';
    
    // 更新数据
    tagConverter.filterManager.updateGroup(groupId, { 
        collapsed: !newExpanded 
    });
    
    // 如果展开，聚焦到关键词输入框
    if (newExpanded) {
        setTimeout(() => {
            const keywordInput = groupContent.querySelector('.keyword-input-simple');
            if (keywordInput) {
                keywordInput.focus();
            }
        }, 100);
    }
}

/**
 * 切换组菜单显示
 * @param {HTMLElement} button - 菜单按钮
 */
function toggleGroupMenu(button) {
    const dropdown = button.nextElementSibling;
    if (dropdown) {
        const isVisible = dropdown.style.display !== 'none';
        
        // 关闭其他菜单
        document.querySelectorAll('.menu-dropdown').forEach(menu => {
            menu.style.display = 'none';
        });
        
        // 切换当前菜单
        dropdown.style.display = isVisible ? 'none' : 'block';
        
        // 点击外部关闭菜单
        if (!isVisible) {
            setTimeout(() => {
                const closeMenu = (e) => {
                    if (!button.contains(e.target) && !dropdown.contains(e.target)) {
                        dropdown.style.display = 'none';
                        document.removeEventListener('click', closeMenu);
                    }
                };
                document.addEventListener('click', closeMenu);
            }, 0);
        }
    }
}

/**
 * 复制组
 * @param {HTMLElement} menuItem - 菜单项元素
 */
function duplicateGroup(menuItem) {
    const groupElement = menuItem.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    
    if (groupId) {
        tagConverter.filterManager.duplicateGroup(groupId);
        renderAllGroups();
        updateFilterStats();
        updateEmptyState();
    }
    
    // 关闭菜单
    const dropdown = menuItem.closest('.menu-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

/**
 * 清零组命中计数
 * @param {HTMLElement} menuItem - 菜单项元素
 */
function clearGroupMatchCount(menuItem) {
    const groupElement = menuItem.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    
    if (groupId) {
        tagConverter.filterManager.clearMatchCounts(groupId);
        
        // 更新徽标显示
        const matchBadge = groupElement.querySelector('.group-match-badge');
        if (matchBadge) {
            matchBadge.textContent = tagConverter.filterManager.masterEnabled ? '•0' : '—';
            matchBadge.classList.remove('has-matches');
        }
    }
    
    // 关闭菜单
    const dropdown = menuItem.closest('.menu-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

/**
 * 删除组
 * @param {HTMLElement} menuItem - 菜单项元素
 */
function deleteGroup(menuItem) {
    const groupElement = menuItem.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    const group = tagConverter.filterManager.getGroup(groupId);
    
    if (groupId && group) {
        // 确认删除
        const confirmed = confirm(`确定要删除组"${group.name}"吗？此操作不可恢复。`);
        if (confirmed) {
            tagConverter.filterManager.deleteGroup(groupId);
            renderAllGroups();
            updateFilterStats();
            updateEmptyState();
            
            // 重新转换
            convert();
        }
    }
    
    // 关闭菜单
    const dropdown = menuItem.closest('.menu-dropdown');
    if (dropdown) {
        dropdown.style.display = 'none';
    }
}

/**
 * 处理关键词输入
 * @param {KeyboardEvent} event - 键盘事件
 */
function handleKeywordInput(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        addKeywordFromInput(event.target);
    } else if (event.key === 'Backspace' && event.target.value === '') {
        // 删除最后一个关键词
        const groupElement = event.target.closest('.group-card');
        const groupId = groupElement?.getAttribute('data-group-id');
        const group = tagConverter.filterManager.getGroup(groupId);
        
        if (group && group.keywords.length > 0) {
            group.keywords.pop();
            tagConverter.filterManager.updateGroup(groupId, { keywords: group.keywords });
            renderGroupKeywords(groupElement, group);
            convert();
        }
    }
}

/**
 * 从输入框添加关键词
 * @param {HTMLInputElement} input - 输入框
 */
function addKeywordFromInput(input) {
    const value = input.value.trim();
    if (!value) return;
    
    const groupElement = input.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    const group = tagConverter.filterManager.getGroup(groupId);
    
    if (group) {
        // 支持批量添加（逗号分隔）
        const newKeywords = value.split(',').map(k => k.trim()).filter(k => k.length > 0);
        
        for (const keyword of newKeywords) {
            if (!group.keywords.includes(keyword)) {
                group.keywords.push(keyword);
            }
        }
        
        tagConverter.filterManager.updateGroup(groupId, { keywords: group.keywords });
        renderGroupKeywords(groupElement, group);
        
        input.value = '';
        convert();
        updateFilterStats();
    }
}

/**
 * 聚焦关键词输入框
 * @param {HTMLElement} container - 关键词容器
 */
function focusKeywordInput(container) {
    const input = container.parentElement?.querySelector('.keyword-input-simple');
    if (input) {
        input.focus();
    }
}

/**
 * 从组中删除关键词
 * @param {string} groupId - 组ID
 * @param {number} index - 关键词索引
 */
function removeKeywordFromGroup(groupId, index) {
    const group = tagConverter.filterManager.getGroup(groupId);
    if (group) {
        group.keywords.splice(index, 1);
        tagConverter.filterManager.updateGroup(groupId, { keywords: group.keywords });
        
        const groupElement = document.querySelector(`[data-group-id="${groupId}"]`);
        if (groupElement) {
            renderGroupKeywords(groupElement, group);
        }
        
        convert();
        updateFilterStats();
    }
}

/**
 * 更新替换短语
 * @param {HTMLInputElement} input - 输入框元素
 */
function updateReplacement(input) {
    const groupElement = input.closest('.group-card');
    const groupId = groupElement?.getAttribute('data-group-id');
    
    if (groupId) {
        tagConverter.filterManager.updateGroup(groupId, { 
            replacement: input.value 
        });
        
        // 重新转换
        convert();
        updateFilterStats();
    }
}

/**
 * 验证替换短语输入
 * @param {HTMLInputElement} input - 输入框元素
 */
function validateReplacement(input) {
    validateReplacementInput(input);
}

/**
 * 验证替换短语输入格式
 * @param {HTMLInputElement} input - 输入框元素
 */
function validateReplacementInput(input) {
    const errorDiv = input.parentElement?.querySelector('.replacement-error');
    if (!errorDiv) return;
    
    const value = input.value;
    const isValid = tagConverter.filterManager._isValidReplacement(value);
    
    if (!isValid) {
        input.classList.add('error');
        errorDiv.style.display = 'block';
    } else {
        input.classList.remove('error');
        errorDiv.style.display = 'none';
    }
}

/**
 * 导出配置
 */
function exportConfig() {
    try {
        const config = tagConverter.filterManager.exportConfig();
        
        // 创建下载链接
        const blob = new Blob([config], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `tag-filter-config-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        
        // 简单的成功提示
        const exportBtn = document.getElementById('export-btn');
        if (exportBtn) {
            const originalText = exportBtn.textContent;
            exportBtn.textContent = '✓';
            exportBtn.style.background = CONFIG.UI.COPY_SUCCESS_COLOR;
            setTimeout(() => {
                exportBtn.textContent = originalText;
                exportBtn.style.background = '';
            }, 1500);
        }
    } catch (error) {
        console.error('导出失败:', error);
        alert('导出失败：' + error.message);
    }
}

/**
 * 导入配置
 */
function importConfig() {
    const fileInput = document.getElementById('import-file');
    if (fileInput) {
        fileInput.click();
    }
}

/**
 * 处理导入文件
 * @param {Event} event - 文件输入事件
 */
function handleImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const configJson = e.target?.result;
            if (typeof configJson !== 'string') return;
            
            // 显示预览和确认对话框
            showImportPreview(configJson);
        } catch (error) {
            console.error('文件读取失败:', error);
            alert('文件读取失败：' + error.message);
        }
    };
    
    reader.readAsText(file);
    
    // 重置文件输入
    event.target.value = '';
}

/**
 * 显示导入预览
 * @param {string} configJson - 配置JSON字符串
 */
function showImportPreview(configJson) {
    const preview = tagConverter.filterManager.getImportPreview(configJson);
    
    if (!preview.valid) {
        alert('配置文件无效：' + preview.error);
        return;
    }
    
    const { preview: previewData } = preview;
    const message = `即将导入配置：
    
• 总开关：${previewData.masterEnabled ? '启用' : '禁用'}
• 简化功能：${previewData.simplifyEnabled ? '启用' : '禁用'}  
• 组数量：${previewData.groupCount} 个
• 总关键词：${previewData.totalKeywords} 个
• 组名：${previewData.groupNames.join(', ')}

导入方式：
[确定] = 覆盖现有配置
[取消] = 取消导入

是否继续？`;
    
    const confirmed = confirm(message);
    if (confirmed) {
        // 覆盖模式导入
        const result = tagConverter.filterManager.importConfig(configJson, false);
        
        if (result.success) {
            // 重新渲染UI
            initializeGroupedFilterUI();
            convert();
            alert(`导入成功！已导入 ${result.importedGroups} 个组`);
        } else {
            alert('导入失败：' + result.error);
        }
    }
}

// ====================================================================
// 拖拽排序功能
// ====================================================================

/**
 * 初始化拖拽排序
 */
function initializeDragAndDrop() {
    const groupsContainer = document.getElementById('filter-groups');
    if (!groupsContainer) return;
    
    // 为每个组添加拖拽事件
    addDragListeners();
}

/**
 * 为组卡片添加拖拽监听器
 */
function addDragListeners() {
    const groupCards = document.querySelectorAll('.group-card');
    
    groupCards.forEach(card => {
        const dragHandle = card.querySelector('.drag-handle');
        if (!dragHandle) return;
        
        // 添加拖拽事件
        dragHandle.addEventListener('mousedown', handleDragStart);
        dragHandle.addEventListener('touchstart', handleDragStart, { passive: false });
    });
}

/**
 * 处理拖拽开始
 * @param {MouseEvent|TouchEvent} event - 事件对象
 */
function handleDragStart(event) {
    event.preventDefault();
    
    const groupCard = event.target.closest('.group-card');
    if (!groupCard) return;
    
    const groupsContainer = document.getElementById('filter-groups');
    if (!groupsContainer) return;
    
    const isTouch = event.type === 'touchstart';
    
    // 创建拖拽状态
    const dragState = {
        draggedCard: groupCard,
        container: groupsContainer,
        startY: isTouch ? event.touches[0].clientY : event.clientY,
        initialIndex: Array.from(groupsContainer.children).indexOf(groupCard),
        isTouch
    };
    
    // 添加拖拽样式
    groupCard.classList.add('dragging');
    
    // 创建占位符
    const placeholder = createDragPlaceholder(groupCard);
    groupCard.parentNode.insertBefore(placeholder, groupCard.nextSibling);
    
    dragState.placeholder = placeholder;
    
    // 添加移动和结束事件监听器
    const moveEvent = isTouch ? 'touchmove' : 'mousemove';
    const endEvent = isTouch ? 'touchend' : 'mouseup';
    
    const handleMove = (e) => handleDragMove(e, dragState);
    const handleEnd = (e) => handleDragEnd(e, dragState);
    
    document.addEventListener(moveEvent, handleMove, { passive: false });
    document.addEventListener(endEvent, handleEnd, { once: true });
    
    // 存储清理函数
    dragState.cleanup = () => {
        document.removeEventListener(moveEvent, handleMove);
        document.removeEventListener(endEvent, handleEnd);
    };
}

/**
 * 创建拖拽占位符
 * @param {HTMLElement} originalCard - 原始卡片
 * @returns {HTMLElement} 占位符元素
 */
function createDragPlaceholder(originalCard) {
    const placeholder = document.createElement('div');
    placeholder.className = 'group-card-placeholder';
    placeholder.style.cssText = `
        height: ${originalCard.offsetHeight}px;
        background: #f0f8ff;
        border: 2px dashed #007AFF;
        border-radius: 10px;
        margin-bottom: 0.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #007AFF;
        font-size: 14px;
        opacity: 0.8;
    `;
    placeholder.textContent = '放置到这里';
    return placeholder;
}

/**
 * 处理拖拽移动
 * @param {MouseEvent|TouchEvent} event - 事件对象
 * @param {Object} dragState - 拖拽状态
 */
function handleDragMove(event, dragState) {
    event.preventDefault();
    
    const { draggedCard, container, placeholder, isTouch } = dragState;
    
    const currentY = isTouch ? event.touches[0].clientY : event.clientY;
    
    // 找到鼠标/触摸位置应该插入的位置
    const afterElement = getDragAfterElement(container, currentY);
    
    if (afterElement == null) {
        container.appendChild(placeholder);
    } else {
        container.insertBefore(placeholder, afterElement);
    }
}

/**
 * 获取拖拽后应该插入的元素
 * @param {HTMLElement} container - 容器元素
 * @param {number} y - Y坐标
 * @returns {HTMLElement|null}
 */
function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.group-card:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/**
 * 处理拖拽结束
 * @param {MouseEvent|TouchEvent} event - 事件对象
 * @param {Object} dragState - 拖拽状态
 */
function handleDragEnd(event, dragState) {
    const { draggedCard, container, placeholder, initialIndex, cleanup } = dragState;
    
    // 清理事件监听器
    cleanup();
    
    // 移除拖拽样式
    draggedCard.classList.remove('dragging');
    
    // 将拖拽的卡片放到占位符位置
    container.insertBefore(draggedCard, placeholder);
    container.removeChild(placeholder);
    
    // 获取新的索引
    const newIndex = Array.from(container.children).indexOf(draggedCard);
    
    // 如果位置发生变化，更新数据
    if (newIndex !== initialIndex) {
        updateGroupOrder();
        
        // 重新转换以应用新的过滤顺序
        convert();
    }
}

/**
 * 更新组顺序
 */
function updateGroupOrder() {
    const groupsContainer = document.getElementById('filter-groups');
    if (!groupsContainer) return;
    
    const groupCards = Array.from(groupsContainer.querySelectorAll('.group-card'));
    const newGroupIds = groupCards.map(card => card.getAttribute('data-group-id')).filter(Boolean);
    
    // 更新过滤器管理器中的顺序
    tagConverter.filterManager.reorderGroups(newGroupIds);
    
    console.log('组顺序已更新:', newGroupIds);
}

// 键盘辅助功能（可选）
/**
 * 处理键盘拖拽
 * @param {KeyboardEvent} event - 键盘事件
 */
function handleKeyboardDrag(event) {
    if (event.target.classList.contains('drag-handle')) {
        const groupCard = event.target.closest('.group-card');
        if (!groupCard) return;
        
        const groupsContainer = document.getElementById('filter-groups');
        const cards = Array.from(groupsContainer.querySelectorAll('.group-card'));
        const currentIndex = cards.indexOf(groupCard);
        
        if (event.key === 'ArrowUp' && currentIndex > 0) {
            // 向上移动
            event.preventDefault();
            const prevCard = cards[currentIndex - 1];
            groupsContainer.insertBefore(groupCard, prevCard);
            updateGroupOrder();
            convert();
            
            // 保持焦点
            event.target.focus();
        } else if (event.key === 'ArrowDown' && currentIndex < cards.length - 1) {
            // 向下移动
            event.preventDefault();
            const nextCard = cards[currentIndex + 1];
            groupsContainer.insertBefore(groupCard, nextCard.nextSibling);
            updateGroupOrder();
            convert();
            
            // 保持焦点
            event.target.focus();
        }
    }
}

// 在初始化时添加键盘事件监听
document.addEventListener('keydown', handleKeyboardDrag);

// 全局点击事件处理（关闭菜单）
document.addEventListener('click', function(event) {
    // 如果点击的不是菜单按钮或菜单项，关闭所有菜单
    if (!event.target.closest('.group-menu')) {
        document.querySelectorAll('.menu-dropdown').forEach(menu => {
            menu.style.display = 'none';
        });
    }
});