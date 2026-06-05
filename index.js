require("dotenv").config();

const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3001;
const CONFIG_PATH = path.join(__dirname, "config.json");
const MAX_LOGS = 50;
const eventLogs = [];
const moderationCommands = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre")
    .addUserOption((option) =>
      option
        .setName("utilisateur")
        .setDescription("Utilisateur a bannir")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("raison")
        .setDescription("Raison du bannissement")
        .setMaxLength(512)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Debannir un utilisateur")
    .addStringOption((option) =>
      option
        .setName("utilisateur_id")
        .setDescription("ID Discord de l'utilisateur a debannir")
        .setRequired(true)
        .setMinLength(17)
        .setMaxLength(20)
    )
    .addStringOption((option) =>
      option
        .setName("raison")
        .setDescription("Raison du debannissement")
        .setMaxLength(512)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulser un membre")
    .addUserOption((option) =>
      option
        .setName("utilisateur")
        .setDescription("Utilisateur a expulser")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("raison")
        .setDescription("Raison de l'expulsion")
        .setMaxLength(512)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false)
];

const defaultConfig = {
  modules: {
    welcome: true,
    leave: true,
    logs: true
  },
  welcomeChannelId: "",
  leaveChannelId: "",
  logsChannelId: "",
  welcomeTitle: "Bienvenue !",
  welcomeMessage: "Bienvenue {user} sur {server} !",
  leaveTitle: "Au revoir !",
  leaveMessage: "{user} a quitte le serveur.",
  embedColor: "#8b5cf6"
};

function getPrimaryGuild() {
  return client.guilds.cache.first() || null;
}

function sanitizeConfig(input = {}) {
  const modules = {
    ...defaultConfig.modules,
    ...(input.modules || {})
  };

  const config = {
    ...defaultConfig,
    ...input,
    modules: {
      welcome: Boolean(modules.welcome),
      leave: Boolean(modules.leave),
      logs: Boolean(modules.logs)
    },
    welcomeChannelId: String(input.welcomeChannelId || "").trim(),
    leaveChannelId: String(input.leaveChannelId || "").trim(),
    logsChannelId: String(input.logsChannelId || "").trim(),
    welcomeTitle: String(input.welcomeTitle || defaultConfig.welcomeTitle).trim(),
    welcomeMessage: String(input.welcomeMessage || defaultConfig.welcomeMessage).trim(),
    leaveTitle: String(input.leaveTitle || defaultConfig.leaveTitle).trim(),
    leaveMessage: String(input.leaveMessage || defaultConfig.leaveMessage).trim(),
    embedColor: String(input.embedColor || defaultConfig.embedColor).trim()
  };

  if (!/^#[0-9a-f]{6}$/i.test(config.embedColor)) {
    config.embedColor = defaultConfig.embedColor;
  }

  return config;
}

function replaceTags(text, memberOrGuild) {
  const user = memberOrGuild.user ? memberOrGuild.user : null;
  const guild = memberOrGuild.guild || memberOrGuild;
  const memberCount = guild.memberCount || guild.approximateMemberCount || 0;

  return String(text || "")
    .replaceAll("{user}", user ? `<@${user.id}>` : "@Utilisateur")
    .replaceAll("{username}", user ? user.username : "Utilisateur")
    .replaceAll("{server}", guild.name || "Serveur Discord")
    .replaceAll("{memberCount}", String(memberCount));
}

function buildMemberEmbed(config, memberOrGuild, type) {
  const isWelcome = type === "welcome";

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(replaceTags(isWelcome ? config.welcomeTitle : config.leaveTitle, memberOrGuild))
    .setDescription(replaceTags(isWelcome ? config.welcomeMessage : config.leaveMessage, memberOrGuild))
    .setFooter({ text: `${memberOrGuild.guild?.memberCount || memberOrGuild.memberCount || 0} membres` })
    .setTimestamp();
}

function pushLog(type, member) {
  const entry = {
    id: `${Date.now()}-${member.id}`,
    type,
    username: member.user.tag,
    userId: member.id,
    guildName: member.guild.name,
    createdAt: new Date().toISOString()
  };

  eventLogs.unshift(entry);
  eventLogs.splice(MAX_LOGS);
}

function pushModerationLog(type, guild, targetUser, moderatorUser, reason) {
  const entry = {
    id: `${Date.now()}-${targetUser.id}`,
    type,
    username: targetUser.tag || targetUser.username || targetUser.id,
    userId: targetUser.id,
    moderator: moderatorUser.tag,
    moderatorId: moderatorUser.id,
    guildName: guild.name,
    reason,
    createdAt: new Date().toISOString()
  };

  eventLogs.unshift(entry);
  eventLogs.splice(MAX_LOGS);
}

async function readConfig() {
  try {
    const rawConfig = await fs.readFile(CONFIG_PATH, "utf8");
    return sanitizeConfig(JSON.parse(rawConfig));
  } catch (error) {
    console.error("Impossible de lire config.json, config par defaut utilisee.", error);
    return defaultConfig;
  }
}

async function writeConfig(config) {
  const nextConfig = sanitizeConfig(config);
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return nextConfig;
}

async function fetchTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function sendLogMessage(config, member, type) {
  if (!config.modules.logs || !config.logsChannelId) return;

  const channel = await fetchTextChannel(member.guild, config.logsChannelId);
  if (!channel) return;

  const label = type === "join" ? "Join" : "Leave";
  await channel.send(`${label}: ${member.user.tag} (${member.id})`);
}

async function sendModerationLog(guild, type, targetUser, moderatorUser, reason) {
  const config = await readConfig();
  if (!config.modules.logs || !config.logsChannelId) return;

  const channel = await fetchTextChannel(guild, config.logsChannelId);
  if (!channel) return;

  const labels = {
    ban: "Bannissement",
    unban: "Debannissement",
    kick: "Expulsion"
  };

  const embed = new EmbedBuilder()
    .setColor(type === "unban" ? "#34d399" : "#fb7185")
    .setTitle(labels[type] || "Moderation")
    .addFields(
      { name: "Utilisateur", value: `${targetUser.tag || targetUser.id} (${targetUser.id})`, inline: false },
      { name: "Moderateur", value: `${moderatorUser.tag} (${moderatorUser.id})`, inline: false },
      { name: "Raison", value: reason, inline: false }
    )
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function sendMemberEmbed(member, type) {
  const config = await readConfig();
  const isWelcome = type === "welcome";

  if (isWelcome && !config.modules.welcome) return;
  if (!isWelcome && !config.modules.leave) return;

  const channelId = isWelcome
    ? config.welcomeChannelId || process.env.WELCOME_CHANNEL_ID
    : config.leaveChannelId;
  const channel = await fetchTextChannel(member.guild, channelId);

  if (!channel) return;

  const embed = buildMemberEmbed(config, member, type)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));

  await channel.send({ embeds: [embed] });
}

function canModerateMember(interaction, member, action) {
  if (!member) {
    return "Utilisateur introuvable sur ce serveur.";
  }

  if (member.id === interaction.user.id) {
    return "Tu ne peux pas utiliser cette commande sur toi-meme.";
  }

  if (member.id === interaction.client.user.id) {
    return "Je ne peux pas appliquer cette action sur moi-meme.";
  }

  if (member.id === interaction.guild.ownerId) {
    return "Impossible d'appliquer cette action au proprietaire du serveur.";
  }

  if (interaction.member.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return "Ton role doit etre au-dessus de celui de cet utilisateur.";
  }

  const botMember = interaction.guild.members.me;
  if (!botMember || botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return "Mon role doit etre au-dessus de celui de cet utilisateur.";
  }

  if (action === "ban" && !member.bannable) {
    return "Je n'ai pas la permission de bannir cet utilisateur.";
  }

  if (action === "kick" && !member.kickable) {
    return "Je n'ai pas la permission d'expulser cet utilisateur.";
  }

  return null;
}

async function replyError(interaction, content) {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral
  });
}

async function executeBan(interaction) {
  const user = interaction.options.getUser("utilisateur");
  const reason = interaction.options.getString("raison") || "Aucune raison";
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const error = canModerateMember(interaction, member, "ban");

  if (error) {
    await replyError(interaction, error);
    return;
  }

  await member.ban({ reason });
  pushModerationLog("ban", interaction.guild, user, interaction.user, reason);
  await sendModerationLog(interaction.guild, "ban", user, interaction.user, reason);

  await interaction.reply(`Ban: ${user.tag} a ete banni.\nRaison : ${reason}`);
}

async function executeKick(interaction) {
  const user = interaction.options.getUser("utilisateur");
  const reason = interaction.options.getString("raison") || "Aucune raison";
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const error = canModerateMember(interaction, member, "kick");

  if (error) {
    await replyError(interaction, error);
    return;
  }

  await member.kick(reason);
  pushModerationLog("kick", interaction.guild, user, interaction.user, reason);
  await sendModerationLog(interaction.guild, "kick", user, interaction.user, reason);

  await interaction.reply(`Kick: ${user.tag} a ete expulse.\nRaison : ${reason}`);
}

async function executeUnban(interaction) {
  const userId = interaction.options.getString("utilisateur_id").trim();
  const reason = interaction.options.getString("raison") || "Aucune raison";

  if (!/^\d{17,20}$/.test(userId)) {
    await replyError(interaction, "ID utilisateur invalide.");
    return;
  }

  const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
  if (!ban) {
    await replyError(interaction, "Cet utilisateur n'est pas dans la liste des bans.");
    return;
  }

  await interaction.guild.members.unban(userId, reason);
  pushModerationLog("unban", interaction.guild, ban.user, interaction.user, reason);
  await sendModerationLog(interaction.guild, "unban", ban.user, interaction.user, reason);

  await interaction.reply(`Unban: ${ban.user.tag} a ete debanni.\nRaison : ${reason}`);
}

async function handleModerationCommand(interaction) {
  if (!interaction.inGuild()) {
    await replyError(interaction, "Cette commande fonctionne seulement dans un serveur.");
    return;
  }

  if (interaction.commandName === "ban") {
    await executeBan(interaction);
    return;
  }

  if (interaction.commandName === "unban") {
    await executeUnban(interaction);
    return;
  }

  if (interaction.commandName === "kick") {
    await executeKick(interaction);
  }
}

function serializeGuild(guild) {
  if (!guild) {
    return {
      ready: client.isReady(),
      id: "",
      name: "Aucun serveur",
      iconUrl: "",
      memberCount: 0
    };
  }

  return {
    ready: client.isReady(),
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 128 }) || "",
    memberCount: guild.memberCount
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once(Events.ClientReady, async () => {
  console.log(`Connecte en tant que ${client.user.tag}`);

  try {
    await Promise.all(
      client.guilds.cache.map((guild) =>
        Promise.all(
          moderationCommands.map((command) =>
            guild.commands.create(command.toJSON())
          )
        )
      )
    );
    console.log("Commandes de moderation synchronisees.");
  } catch (error) {
    console.error("Impossible de synchroniser les commandes de moderation.", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!["ban", "unban", "kick"].includes(interaction.commandName)) return;

  try {
    await handleModerationCommand(interaction);
  } catch (error) {
    console.error(error);

    const message = "Une erreur est survenue pendant la commande de moderation.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
      return;
    }

    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => null);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  pushLog("join", member);

  try {
    const config = await readConfig();
    await Promise.all([
      sendMemberEmbed(member, "welcome"),
      sendLogMessage(config, member, "join")
    ]);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  pushLog("leave", member);

  try {
    const config = await readConfig();
    await Promise.all([
      sendMemberEmbed(member, "leave"),
      sendLogMessage(config, member, "leave")
    ]);
  } catch (error) {
    console.error(error);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", async (req, res) => {
  res.json(await readConfig());
});

app.put("/api/config", async (req, res) => {
  try {
    const config = await writeConfig(req.body);
    res.json({ ok: true, config });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "Impossible de sauvegarder la configuration." });
  }
});

app.get("/api/guild", (req, res) => {
  res.json({
    botName: client.user?.tag || "Bot hors ligne",
    guild: serializeGuild(getPrimaryGuild())
  });
});

app.get("/api/channels", async (req, res) => {
  const guild = getPrimaryGuild();

  if (!guild) {
    res.json([]);
    return;
  }

  const channels = guild.channels.cache
    .filter((channel) => (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement
    ))
    .sort((first, second) => first.rawPosition - second.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type
    }));

  res.json(channels);
});

app.get("/api/logs", (req, res) => {
  res.json(eventLogs);
});

app.post("/api/test-embed", async (req, res) => {
  try {
    const config = sanitizeConfig(req.body.config || await readConfig());
    const type = req.body.type === "leave" ? "leave" : "welcome";
    const guild = getPrimaryGuild();
    const channelId = req.body.channelId || (type === "welcome" ? config.welcomeChannelId : config.leaveChannelId);
    const channel = await fetchTextChannel(guild, channelId);

    if (!guild || !channel) {
      res.status(400).json({ ok: false, message: "Salon introuvable ou bot non connecte." });
      return;
    }

    const embed = buildMemberEmbed(config, guild, type)
      .setThumbnail(guild.iconURL({ size: 256 }) || client.user.displayAvatarURL({ size: 256 }))
      .setAuthor({
        name: guild.name,
        iconURL: guild.iconURL({ size: 128 }) || undefined
      });

    await channel.send({ content: "Test embed depuis le dashboard", embeds: [embed] });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "Impossible d'envoyer le test embed." });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ready: client.isReady(),
    botName: client.user?.tag || "Bot hors ligne",
    guilds: client.guilds.cache.size
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard disponible sur http://localhost:${PORT}`);
});

client.login(process.env.TOKEN);
