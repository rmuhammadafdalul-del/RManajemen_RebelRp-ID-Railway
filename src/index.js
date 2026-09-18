require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  SlashCommandBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`ENV ${key} belum diisi.`);
    process.exit(1);
  }
}

const cfg = {
  guildId: process.env.GUILD_ID,
  staffRoleId: process.env.STAFF_ROLE_ID || '',
  supportCategoryId: process.env.SUPPORT_CATEGORY_ID || '',
  createTicketChannelId: process.env.CREATE_TICKET_CHANNEL_ID || '',
  createTicketChannelName: process.env.CREATE_TICKET_CHANNEL_NAME || 'create-ticket',
  donationCategoryId: process.env.DONATION_CATEGORY_ID || '',
  reportCategoryId: process.env.REPORT_CATEGORY_ID || '',
  formCategoryId: process.env.FORM_CATEGORY_ID || '',
  logChannelId: process.env.LOG_CHANNEL_ID || '',
  donationTimeoutHours: Number(process.env.DONATION_TIMEOUT_HOURS || 24),
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || '',
  goodbyeChannelId: process.env.GOODBYE_CHANNEL_ID || '',
  welcomeImage: process.env.WELCOME_IMAGE_URL || '',
  goodbyeImage: process.env.GOODBYE_IMAGE_URL || '',
  welcomeMessage: process.env.WELCOME_MESSAGE || 'Selamat datang {user} di server!',
  goodbyeMessage: process.env.GOODBYE_MESSAGE || 'See you {user}, semoga sukses!',
  rolePanelChannelId: process.env.ROLE_PANEL_CHANNEL_ID || ''
};
const donationTimeoutMs = cfg.donationTimeoutHours * 60 * 60 * 1000;

function parseRoleButtons(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(item => {
      const [label, roleId, emoji = '🎭'] = item.split('|').map(x => x.trim());
      return { label, roleId, emoji };
    })
    .filter(x => x.label && /^\d{17,20}$/.test(x.roleId));
}
const roleButtons = parseRoleButtons(process.env.ROLE_BUTTONS);

const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'tickets.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    ticket_number INTEGER NOT NULL,
    channel_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    donation_confirmed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(guild_id, status);
  CREATE TABLE IF NOT EXISTS counters (
    guild_id TEXT PRIMARY KEY,
    ticket_number INTEGER NOT NULL DEFAULT 0
  );
`);

const insertTicket = db.prepare(`INSERT INTO tickets
  (guild_id, ticket_number, channel_id, user_id, type, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`);
const getTicket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?');
const updateTicket = db.prepare(`UPDATE tickets SET status = ?, updated_at = ?, donation_confirmed_at = ? WHERE channel_id = ?`);
const expiredDonations = db.prepare(`SELECT * FROM tickets WHERE type = 'donation' AND status = 'open' AND created_at <= ?`);
const nextCounter = db.transaction(guildId => {
  const row = db.prepare('SELECT ticket_number FROM counters WHERE guild_id = ?').get(guildId);
  const next = (row?.ticket_number || 0) + 1;
  db.prepare(`INSERT INTO counters(guild_id, ticket_number) VALUES(?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET ticket_number = excluded.ticket_number`).run(guildId, next);
  return next;
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function isStaff(member) {
  return Boolean(cfg.staffRoleId && member?.roles?.cache?.has(cfg.staffRoleId));
}

function replaceVars(template, memberOrUser) {
  const user = memberOrUser?.user || memberOrUser;
  const id = user?.id || '';
  const mention = id ? `<@${id}>` : (user?.username || 'member');
  const username = user?.username || memberOrUser?.displayName || 'member';
  return template.replaceAll('{user}', mention).replaceAll('{username}', username);
}

function validId(value) {
  return /^\d{17,20}$/.test(String(value || ''));
}

async function getTextChannelById(guild, id) {
  if (!validId(id)) return null;
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  return channel?.type === ChannelType.GuildText ? channel : null;
}

async function getCategoryById(guild, id, label) {
  if (!validId(id)) throw new Error(`${label} belum diisi dengan ID Discord yang valid.`);
  const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildCategory) {
    throw new Error(`${label} tidak ditemukan atau bukan kategori Discord.`);
  }
  return channel;
}

async function getOrCreateSetupChannel(guild) {
  if (cfg.createTicketChannelId) {
    const channel = await getTextChannelById(guild, cfg.createTicketChannelId);
    if (!channel) throw new Error('CREATE_TICKET_CHANNEL_ID tidak ditemukan atau bukan channel text.');
    if (channel.parentId !== cfg.supportCategoryId) {
      throw new Error('CREATE_TICKET_CHANNEL_ID bukan berada di SUPPORT_CATEGORY_ID. Pindahkan channel ke kategori Support atau perbaiki ID.');
    }
    return channel;
  }
  const category = await getCategoryById(guild, cfg.supportCategoryId, 'SUPPORT_CATEGORY_ID');
  let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === cfg.createTicketChannelName && c.parentId === category.id);
  if (!channel) {
    channel = await guild.channels.create({ name: cfg.createTicketChannelName, type: ChannelType.GuildText, parent: category.id });
  }
  return channel;
}

async function logAction(guild, title, description) {
  const channel = await getTextChannelById(guild, cfg.logChannelId);
  if (!channel) return;
  await channel.send({
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp()]
  }).catch(() => {});
}

function ticketCategoryId(type) {
  return type === 'donation' ? cfg.donationCategoryId : type === 'report' ? cfg.reportCategoryId : cfg.formCategoryId;
}

function ticketLabel(type) {
  return type === 'donation' ? '💰 TIKET DONASI' : type === 'report' ? '📢 TIKET REPORT' : '📝 TIKET FORMULIR';
}

function supportEmbed() {
  return new EmbedBuilder()
    .setTitle('🎫 SUPPORT CENTER')
    .setDescription(
      'Silakan pilih layanan yang kamu perlukan.\n\n' +
      '📢 **Report** — membuat tiket laporan.\n' +
      '📝 **Formulir** — mengisi formulir.\n' +
      '💰 **Donasi** — membuat tiket donasi dan mengirim bukti pembayaran.\n\n' +
      `⏳ Tiket donasi yang belum dikonfirmasi akan otomatis dihapus setelah **${cfg.donationTimeoutHours} jam**.`
    )
    .setFooter({ text: 'Admin / Helper akan memproses tiket.' });
}
function supportRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_report').setLabel('Report').setEmoji('📢').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('open_form').setLabel('Formulir').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('open_donation').setLabel('Donasi').setEmoji('💰').setStyle(ButtonStyle.Success)
  )];
}

function roleEmbed() {
  return new EmbedBuilder()
    .setTitle('🎭 PENGAMBILAN ROLE')
    .setDescription('Klik tombol untuk mengambil role. Klik lagi untuk melepas role yang sama.')
    .setFooter({ text: 'Role diberikan/dilepas otomatis.' });
}
function roleRows() {
  const rows = [];
  for (let i = 0; i < roleButtons.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const item of roleButtons.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder()
        .setCustomId(`selfrole:${item.roleId}`)
        .setLabel(item.label.slice(0, 80))
        .setEmoji(item.emoji)
        .setStyle(ButtonStyle.Secondary));
    }
    rows.push(row);
  }
  return rows;
}

function reportModal() {
  return new ModalBuilder().setCustomId('modal_report').setTitle('Report').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Judul laporan').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Jelaskan laporan').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('evidence').setLabel('Bukti / ID terkait (opsional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
  );
}
function formModal() {
  return new ModalBuilder().setCustomId('modal_form').setTitle('Formulir').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nama').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('contact').setLabel('Kontak / ID Discord').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('purpose').setLabel('Keperluan').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2000))
  );
}
function donationModal() {
  return new ModalBuilder().setCustomId('modal_donation').setTitle('Form Donasi').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Nominal donasi').setPlaceholder('Contoh: 50000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('method').setLabel('Metode pembayaran').setPlaceholder('Transfer / E-wallet').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note').setLabel('Catatan (opsional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000))
  );
}

async function createTicket(interaction, type, details) {
  // Multi-ticket: tidak ada pembatasan satu tiket per user.
  const category = await getCategoryById(interaction.guild, ticketCategoryId(type), type === 'donation' ? 'DONATION_CATEGORY_ID' : type === 'report' ? 'REPORT_CATEGORY_ID' : 'FORM_CATEGORY_ID');
  const staffRole = cfg.staffRoleId ? interaction.guild.roles.cache.get(cfg.staffRoleId) : null;
  const staffRoles = staffRole ? [staffRole] : [];
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.AttachFiles] }
  ];
  for (const role of staffRoles) overwrites.push({
    id: role.id,
    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles]
  });

  const number = nextCounter(interaction.guild.id);
  const ticketNumber = String(number).padStart(4, '0');
  const channel = await interaction.guild.channels.create({
    name: `ticket-${ticketNumber}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: overwrites,
    topic: `Ticket #${ticketNumber} | ${type} | User ${interaction.user.id}`
  });
  const now = Date.now();
  insertTicket.run(interaction.guild.id, number, channel.id, interaction.user.id, type, now, now);

  const timeoutText = type === 'donation'
    ? `\n⏳ **Batas konfirmasi: ${cfg.donationTimeoutHours} jam sejak tiket dibuat.**\nKirim **bukti pembayaran sebagai gambar/file** di channel ini.\n`
    : '';
  const embed = new EmbedBuilder()
    .setTitle(`${ticketLabel(type)} • #${ticketNumber}`)
    .setDescription(`Halo <@${interaction.user.id}>.\n\n**Data tiket:**\n${details}${timeoutText}\nAdmin/Helper akan memproses tiket ini.`)
    .setTimestamp();
  const row = type === 'donation'
    ? new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('staff_confirm_donation').setLabel('Confirm Donasi').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staff_reject_donation').setLabel('Reject Donasi').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Tutup Tiket').setStyle(ButtonStyle.Secondary))
    : new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('staff_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('staff_reject').setLabel('Reject').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Tutup Tiket').setStyle(ButtonStyle.Secondary));

  await channel.send({ content: `${staffRoles.map(r => `<@&${r.id}>`).join(' ')} <@${interaction.user.id}>`, embeds: [embed], components: [row] });
  await interaction.reply({ content: `Tiket **#${ticketNumber}** berhasil dibuat: ${channel}`, ephemeral: true });
  await logAction(interaction.guild, '🎫 Tiket Dibuat', `Nomor: **#${ticketNumber}**\nUser: <@${interaction.user.id}>\nTipe: **${type}**\nChannel: ${channel}`);
}

async function closeTicket(channel, reason, actorId) {
  const ticket = getTicket.get(channel.id);
  if (!ticket) return;
  updateTicket.run('closed', Date.now(), ticket.donation_confirmed_at || null, channel.id);
  await logAction(channel.guild, '🗑️ Tiket Ditutup', `Channel: <#${channel.id}>\nAlasan: ${reason}\nOleh: <@${actorId}>`);
  await channel.delete(`Ticket closed: ${reason}`).catch(() => {});
}

async function ensureSupportPanel(guild) {
  const channel = await getOrCreateSetupChannel(guild);
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const alreadyPosted = messages?.some(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === '🎫 SUPPORT CENTER' && m.components?.length);
  if (!alreadyPosted) {
    await channel.send({ embeds: [supportEmbed()], components: supportRows() });
  }
  return channel;
}

async function ensureRolePanel(guild) {
  const channel = await getTextChannelById(guild, cfg.rolePanelChannelId);
  if (!channel) throw new Error('ROLE_PANEL_CHANNEL_ID belum diisi atau channel tidak ditemukan.');
  if (!roleButtons.length) throw new Error('ROLE_BUTTONS belum dikonfigurasi.');
  await channel.send({ embeds: [roleEmbed()], components: roleRows() });
  return channel;
}

async function sendWelcome(member) {
  const channel = await getTextChannelById(member.guild, cfg.welcomeChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle('👋 WELCOME')
    .setDescription(replaceVars(cfg.welcomeMessage, member))
    .addFields({ name: 'Member', value: `${member}`, inline: true }, { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setTimestamp();
  if (cfg.welcomeImage) embed.setImage(cfg.welcomeImage);
  await channel.send({ embeds: [embed] }).catch(() => {});
}
async function sendGoodbye(member) {
  const channel = await getTextChannelById(member.guild, cfg.goodbyeChannelId);
  if (!channel) return;
  const embed = new EmbedBuilder().setTitle('👋 GOODBYE')
    .setDescription(replaceVars(cfg.goodbyeMessage, member))
    .addFields({ name: 'Member', value: member.user?.tag || member.displayName || 'Unknown', inline: true }, { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true })
    .setTimestamp();
  if (member.user) embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  if (cfg.goodbyeImage) embed.setImage(cfg.goodbyeImage);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function cleanExpiredDonations() {
  const cutoff = Date.now() - donationTimeoutMs;
  for (const ticket of expiredDonations.all(cutoff)) {
    try {
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      updateTicket.run('expired', Date.now(), null, ticket.channel_id);
      if (channel) {
        await logAction(channel.guild, '⏰ Donasi Auto-Expired', `Tiket #${String(ticket.ticket_number).padStart(4, '0')} milik <@${ticket.user_id}> tidak dikonfirmasi dalam ${cfg.donationTimeoutHours} jam.`);
        await channel.delete('Donation ticket expired').catch(() => {});
      }
    } catch (err) { console.error('Cleanup error:', err); }
  }
}

client.once('ready', async () => {
  console.log(`✅ Login sebagai ${client.user.tag}`);
  const guild = await client.guilds.fetch(cfg.guildId);
  const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('Setup channel create-ticket dan kirim panel ticket').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('panel').setDescription('Kirim panel ticket di SUPPORT').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).toJSON(),
    new SlashCommandBuilder().setName('rolepanel').setDescription('Kirim panel pengambilan role').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles).toJSON()
  ];
  await guild.commands.set(commands);
  console.log(`✅ Commands /setup, /panel dan /rolepanel terdaftar di ${guild.name}`);
  await cleanExpiredDonations();
  setInterval(cleanExpiredDonations, 60 * 1000);
});

client.on('guildMemberAdd', member => sendWelcome(member).catch(console.error));
client.on('guildMemberRemove', member => sendGoodbye(member).catch(console.error));

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const ticket = getTicket.get(message.channel.id);
  if (ticket?.type === 'donation' && ticket.status === 'open' && message.attachments.size > 0) {
    await message.channel.send(`📎 Bukti pembayaran terdeteksi dari <@${message.author.id}>. Admin/Helper silakan periksa lalu tekan **Confirm Donasi** atau **Reject Donasi**.`).catch(() => {});
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const channel = await ensureSupportPanel(interaction.guild);
        return interaction.reply({ content: `✅ Create-ticket siap di ${channel}. Panel ticket juga sudah dipasang.`, ephemeral: true });
      }
      if (interaction.commandName === 'panel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const channel = await ensureSupportPanel(interaction.guild);
        return interaction.reply({ content: `Panel support dikirim ke ${channel}.`, ephemeral: true });
      }
      if (interaction.commandName === 'rolepanel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        const channel = await ensureRolePanel(interaction.guild);
        return interaction.reply({ content: `Panel role dikirim ke ${channel}.`, ephemeral: true });
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'open_report') return interaction.showModal(reportModal());
      if (id === 'open_form') return interaction.showModal(formModal());
      if (id === 'open_donation') return interaction.showModal(donationModal());

      if (id.startsWith('selfrole:')) {
        const roleId = id.split(':')[1];
        const configured = roleButtons.find(x => x.roleId === roleId);
        const role = interaction.guild.roles.cache.get(roleId);
        if (!configured || !role) return interaction.reply({ content: 'Role tidak ditemukan.', ephemeral: true });
        if (role.managed) return interaction.reply({ content: 'Role ini dikelola Discord/integrasi dan tidak bisa digunakan.', ephemeral: true });
        const me = interaction.guild.members.me;
        if (!me || role.position >= me.roles.highest.position) return interaction.reply({ content: 'Posisi role bot harus berada di atas role yang akan diberikan.', ephemeral: true });
        if (interaction.member.roles.cache.has(roleId)) {
          await interaction.member.roles.remove(role);
          return interaction.reply({ content: `Role **${role.name}** dilepas.`, ephemeral: true });
        }
        await interaction.member.roles.add(role);
        return interaction.reply({ content: `Role **${role.name}** berhasil diberikan.`, ephemeral: true });
      }

      const ticket = getTicket.get(interaction.channel.id);
      if (id === 'close_ticket') {
        if (!ticket) return interaction.reply({ content: 'Ini bukan tiket.', ephemeral: true });
        if (interaction.user.id !== ticket.user_id && !isStaff(interaction.member)) return interaction.reply({ content: 'Kamu tidak punya izin.', ephemeral: true });
        await interaction.reply({ content: 'Tiket sedang ditutup...', ephemeral: true });
        return closeTicket(interaction.channel, 'Ditutup melalui tombol', interaction.user.id);
      }

      if (['staff_confirm', 'staff_reject', 'staff_confirm_donation', 'staff_reject_donation'].includes(id)) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Hanya Admin/Helper yang dapat melakukan tindakan ini.', ephemeral: true });
        if (!ticket) return interaction.reply({ content: 'Tiket tidak ditemukan.', ephemeral: true });
        if (ticket.status !== 'open') return interaction.reply({ content: 'Tiket ini sudah diproses.', ephemeral: true });
        const donationAction = id.endsWith('_donation');
        if (donationAction !== (ticket.type === 'donation')) return interaction.reply({ content: 'Tombol tidak sesuai dengan tipe tiket.', ephemeral: true });
        const confirmed = id.includes('confirm');
        updateTicket.run(confirmed ? 'confirmed' : 'rejected', Date.now(), confirmed && ticket.type === 'donation' ? Date.now() : null, ticket.channel_id);
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle(confirmed ? '✅ Dikonfirmasi' : '❌ Ditolak').setDescription(`${ticketLabel(ticket.type)} telah **${confirmed ? 'dikonfirmasi' : 'ditolak'}** oleh <@${interaction.user.id}>.`).setTimestamp()] });
        await logAction(interaction.guild, confirmed ? '✅ Tiket Confirm' : '❌ Tiket Reject', `Nomor: #${String(ticket.ticket_number).padStart(4, '0')}\nUser: <@${ticket.user_id}>\nOleh: <@${interaction.user.id}>`);
        if (!confirmed) setTimeout(() => closeTicket(interaction.channel, 'Ditolak oleh Admin/Helper', interaction.user.id), 5000);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_report') {
        const d = `**Judul:** ${interaction.fields.getTextInputValue('subject')}\n**Laporan:** ${interaction.fields.getTextInputValue('description')}\n**Bukti/ID:** ${interaction.fields.getTextInputValue('evidence') || '-'}`;
        return createTicket(interaction, 'report', d);
      }
      if (interaction.customId === 'modal_form') {
        const d = `**Nama:** ${interaction.fields.getTextInputValue('name')}\n**Kontak:** ${interaction.fields.getTextInputValue('contact')}\n**Keperluan:** ${interaction.fields.getTextInputValue('purpose')}`;
        return createTicket(interaction, 'form', d);
      }
      if (interaction.customId === 'modal_donation') {
        const d = `**Nominal:** ${interaction.fields.getTextInputValue('amount')}\n**Metode:** ${interaction.fields.getTextInputValue('method')}\n**Catatan:** ${interaction.fields.getTextInputValue('note') || '-'}`;
        return createTicket(interaction, 'donation', d);
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Terjadi error saat memproses permintaan.', ephemeral: true }).catch(() => {});
  }
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

client.login(process.env.DISCORD_TOKEN);
