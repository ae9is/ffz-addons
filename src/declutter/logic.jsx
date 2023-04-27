"use strict";
const { createElement } = FrankerFaceZ.utilities.dom;

export const DEFAULT_SETTINGS = {
  enabled: false,
  similarity_threshold: 80,
  repetitions_threshold: 3,
  ignore_mods: true,
  force_enable_when_mod: false,
  cache_ttl: 30,
}

/**
 * This addon is toggled on/off by the index addon (or enabled by default via setting),
 *  and performs the actual chat filtering.
 */
export default class Logic extends Addon {
  cache;
  cacheEvictionTimer;
  chatContext;
  RepetitionCounter;
  userId;

  constructor(...args) {
    super(...args);
    this.inject("chat");
    this.inject("settings");
    this.inject("site");
    this.chatContext = this.chat.context;
    this.userId = this.site?.getUser()?.id;
    this.cacheTtl = (this.settings.get('addon.declutter.cache_ttl') ?? DEFAULT_SETTINGS.cache_ttl) * 1000;
  }

  /**
   * Calculates the degree of similarity of 2 strings based on Dices Coefficient
   * @param {string} first  First string for comparison
   * @param {string} second Second string for comparison
   * @returns {number} Degree of similarity in the range [0,1]
   * @see Original source code {@link https://github.com/aceakash/string-similarity}, MIT License
   */
  compareTwoStrings = (first, second) => {
    first = first.replace(/\s+/g, "");
    second = second.replace(/\s+/g, "");
    if (!first.length && !second.length) return 1;
    if (!first.length || !second.length) return 0;
    if (first === second) return 1;
    if (first.length === 1 && second.length === 1) {
      return first === second ? 1 : 0;
    }
    if (first.length < 2 || second.length < 2) return 0;
    const firstBigrams = new Map();
    for (let i = 0; i < first.length - 1; i++) {
      const bigram = first.substring(i, i + 2);
      const count = firstBigrams.has(bigram) ? firstBigrams.get(bigram) + 1 : 1;
      firstBigrams.set(bigram, count);
    }
    let intersectionSize = 0;
    for (let i = 0; i < second.length - 1; i++) {
      const bigram = second.substring(i, i + 2);
      const count = firstBigrams.has(bigram) ? firstBigrams.get(bigram) : 0;
      if (count > 0) {
        firstBigrams.set(bigram, count - 1);
        intersectionSize++;
      }
    }
    return (2.0 * intersectionSize) / (first.length + second.length - 2);
  }

  checkRepetitionAndCache = (message) => {
    const simThreshold = this.settings.get('addon.declutter.similarity_threshold') ?? DEFAULT_SETTINGS.similarity_threshold;
    const repThreshold = this.settings.get('addon.declutter.repetitions_threshold') ?? DEFAULT_SETTINGS.repetitions_threshold;
    if(this.cache) {
      this.cache.expire = Date.now() + this.cacheTtl;
      let n = 1;
      const messagesInCache = this.cache.messages;
      for (let i = 0; i < messagesInCache.length; i++) {
        if(this.compareTwoStrings(message, messagesInCache[i].msg) > simThreshold / 100) {
          n++;
        }
        if (n >= repThreshold) {
          break;
        }
      }
      this.cache.messages.push({msg: message, expire: Date.now() + this.cacheTtl});
      return n;
    } else {
      this.cache = {
        messages: [
          {
            msg: message, expire: Date.now() + this.cacheTtl
          }
        ],
        expire: Date.now() + this.cacheTtl
      };
      return 0;
    }
  }

  onEnable = () => {
    this.log.debug("Enabling Declutterer");
    this.updateConstants();
		this.chat.context.on('changed:addon.declutter.cache_ttl', this.updateConstants, this);
    this.on("chat:receive-message", this.handleMessage, this);
  }

  updateConstants = () => {
    this.cache_ttl = this.chat.context.get('addon.declutter.cache_ttl');
    //Cache eviction will happen 10x per TTL, at least once every 10s, max once per second
    this.startCacheEvictionTimer(
      Math.min(Math.floor(this.cache_ttl / 10), 10)
    );
  }

  onDisable = () => {
    this.log.debug("Disabling Declutterer");
    this.off("chat:receive-message", this.handleMessage, this);
    if (this.cacheEvictionTimer) {
      clearInterval(this.cacheEvictionTimer);
    }
    this.cache = null;
  }

  startCacheEvictionTimer = (intervalSeconds) => {
    if (this.cacheEvictionTimer) {
      clearInterval(this.cacheEvictionTimer);
    }
    this.cacheEvictionTimer = setInterval(() => {
      this.log.debug("Running cache eviction cycle");
      if (this.cache.expire < Date.now()) {
        this.cache = null;
      } else {
        this.cache.messages = this.cache.messages.filter(msg => msg.expire > Date.now());
        if (this.cache.messages.length === 0) {
          this.cache = null;
        }
      }
    }, intervalSeconds * 1000);
  }

  handleMessage = (event) => {
    if (!event.message || event.defaultPrevented) return;
    if(this.chatContext && this.chatContext.get('context.moderator') &&
        !this.settings.get('addon.declutter.force_enable_when_mod')) return;
    const msg = event.message;
    if (msg.ffz_removed || msg.deleted || !msg.ffz_tokens) return;
    if(this.settings.get('addon.declutter.ignore_mods') &&
        (msg.badges.moderator || msg.badges.broadcaster)) return;
    if (msg.user && this.userId && msg.user.id == this.userId) {
      // Always show the user's own messages
      return;
    }
    if(!msg.repetitionCount && msg.repetitionCount !== 0) {
      msg.repetitionCount = this.checkRepetitionAndCache(msg.message);
    }
    const repThreshold = this.settings.get('addon.declutter.repetitions_threshold') ?? DEFAULT_SETTINGS.repetitions_threshold;
    if(msg.repetitionCount >= repThreshold) {
      // Hide messages matching our filter
      event.preventDefault();
    }
  }
}
