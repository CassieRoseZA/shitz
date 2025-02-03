require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    PermissionFlagsBits 
} = require('discord.js');
const fs = require('fs');
const Database = require('better-sqlite3');

// ────────────────
// Database Setup
// ────────────────
const db = new Database('tickets.db');
db.pragma('journal_mode = WAL');

// The table now includes a column for the reported user.
db.prepare(`
    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE,
        channel_id TEXT,
        reported_user TEXT,
        reason TEXT,
        type TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
    )
`).run();

function createTicket(userId, channelId, reportedUser, reason, type) {
    const stmt = db.prepare(`
        INSERT INTO tickets (user_id, channel_id, reported_user, reason, type)
        VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(userId, channelId, reportedUser, reason, type);
}

function closeTicket(channelId) {
    const stmt = db.prepare(`
        UPDATE tickets 
        SET status = 'closed', 
            closed_at = CURRENT_TIMESTAMP
        WHERE channel_id = ?
    `);
    return stmt.run(channelId);
}

function getOpenTicket(userId) {
    const stmt = db.prepare('SELECT * FROM tickets WHERE user_id = ? AND status = "open"');
    return stmt.get(userId);
}

// Get the next sequential ticket number (using the current highest ticket id)
function getNextTicketNumber() {
    const result = db.prepare('SELECT MAX(id) as maxId FROM tickets').get();
    return result && result.maxId ? result.maxId + 1 : 1;
}

// ────────────────
// Deploy Slash Command
// ────────────────
async function deployCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('setup-tickets')
            .setDescription('Setup the ticket system')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .toJSON()
    ];
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        console.log('Deploying commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Commands deployed successfully.');
    } catch (error) {
        console.error('Error deploying commands:', error);
    }
}

// ────────────────
// Client Setup
// ────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const MOD_ROLES = process.env.MOD_ROLES.split(',').map(r => r.trim());
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID; // ID of the category where tickets should be created
const BOT_OWNER = process.env.BOT_OWNER;

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// ────────────────
// Interaction Handlers
// ────────────────
client.on('interactionCreate', async interaction => {
    // Slash Command: /setup-tickets
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-tickets') {
        const embed = new EmbedBuilder()
            .setTitle('Ticket System')
            .setDescription('Please choose the type of ticket you wish to create:')
            .setColor(0x0099FF);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('user_report')
                .setLabel('User Report')
                .setStyle(1),
            new ButtonBuilder()
                .setCustomId('security_report')
                .setLabel('Security Report')
                .setStyle(1)
        );
        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: 'Ticket system setup complete!', ephemeral: true });
    }
    // Button interactions
    else if (interaction.isButton()) {
        if (interaction.customId === 'close_ticket') {
            await handleCloseTicket(interaction);
        } else if (interaction.customId === 'user_report' || interaction.customId === 'security_report') {
            await handleTicketCreation(interaction);
        }
    }
});

// ────────────────
// Ticket Creation Flow
// ────────────────
async function handleTicketCreation(interaction) {
    await interaction.deferUpdate();

    // Only allow one open ticket per user (across all types)
    if (getOpenTicket(interaction.user.id)) {
        return interaction.followUp({ content: '❌ You already have an open ticket!', ephemeral: true });
    }

    // Determine ticket type from the button pressed.
    const ticketType = interaction.customId === 'user_report' ? 'User Report' : 'Security Report';

    // Determine next sequential ticket number.
    const nextTicketNumber = getNextTicketNumber();
    const ticketNumberStr = nextTicketNumber.toString().padStart(3, '0');
    const channelName = `ticket-${ticketNumberStr}`;

    // Create the ticket channel with proper permission overwrites.
    let channel;
    try {
        channel = await interaction.guild.channels.create({
            name: channelName,
            parent: TICKET_CATEGORY_ID,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { 
                    id: interaction.user.id, 
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] 
                },
                ...MOD_ROLES.map(roleId => ({
                    id: roleId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                }))
            ]
        });
    } catch (error) {
        console.error('Error creating ticket channel:', error);
        return interaction.followUp({ content: '❌ Failed to create ticket channel.', ephemeral: true });
    }

    try {
        // ── Step 1: Ask which user is being reported ──
        const promptReported = await channel.send({
            content: `<@${interaction.user.id}>, please mention the user you are reporting.`
        });
        const reportedFilter = m => m.author.id === interaction.user.id;
        const reportedCollected = await channel.awaitMessages({ filter: reportedFilter, max: 1, time: 60000, errors: ['time'] });
        const reportedResponse = reportedCollected.first();
        const reportedUser = reportedResponse.content.trim();
        await reportedResponse.delete().catch(() => {});
        await promptReported.delete().catch(() => {});

        // ── Step 2: Ask for a detailed explanation ──
        const promptReason = await channel.send({
            content: `<@${interaction.user.id}>, please provide a detailed explanation for your report.`
        });
        const reasonCollected = await channel.awaitMessages({ filter: reportedFilter, max: 1, time: 120000, errors: ['time'] });
        const reasonResponse = reasonCollected.first();
        const reasonText = reasonResponse.content.trim();
        await reasonResponse.delete().catch(() => {});
        await promptReason.delete().catch(() => {});

        // ── Final Ticket Embed ──
        const finalEmbed = new EmbedBuilder()
            .setTitle(`Ticket ${channelName}`)
            .setDescription('A new ticket has been created with the following details:')
            .addFields(
                { name: 'Ticket Type', value: ticketType, inline: true },
                { name: 'Reported User', value: reportedUser, inline: true },
                { name: 'Reason', value: reasonText }
            )
            .setColor(0x0099FF)
            .setTimestamp()
            .setFooter({ text: `Ticket created by ${interaction.user.tag}` });

        const closeButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close Ticket')
                .setStyle(4)
        );

        // Send the final formatted message and ping both the ticket creator and moderator roles.
        await channel.send({
            content: `${interaction.user} ${MOD_ROLES.map(roleId => `<@&${roleId}>`).join(' ')}`,
            embeds: [finalEmbed],
            components: [closeButton]
        });

        // Record the ticket in the database.
        createTicket(interaction.user.id, channel.id, reportedUser, reasonText, ticketType);

        await interaction.followUp({ content: `🎫 Ticket created: ${channel}`, ephemeral: true });
    } catch (error) {
        console.error('Error during ticket creation conversation:', error);
        await interaction.followUp({ content: '❌ Ticket creation timed out or failed.', ephemeral: true });
    }
}

// ────────────────
// Ticket Closure Flow
// ────────────────
async function handleCloseTicket(interaction) {
    // Ensure only moderators (with one of the MOD_ROLES) can close tickets.
    if (!interaction.member.roles.cache.some(r => MOD_ROLES.includes(r.id))) {
        return interaction.reply({ content: '❌ You need moderator permissions to close tickets!', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
        // Fetch recent messages to create a transcript.
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const transcript = messages
            .reverse()
            .map(m => `${m.author.tag}: ${m.content}`)
            .join('\n');

        // Write the transcript to a file.
        const fileName = `transcript-${interaction.channel.id}.txt`;
        fs.writeFileSync(fileName, transcript);

        // Send the transcript to the bot owner via DM.
        const owner = await client.users.fetch(BOT_OWNER);
        await owner.send({ 
            content: `Transcript for ${interaction.channel.name}:`,
            files: [fileName] 
        });
        fs.unlinkSync(fileName);

        // Update the ticket status in the database and delete the channel.
        closeTicket(interaction.channel.id);
        await interaction.channel.delete();
    } catch (error) {
        console.error('Error closing ticket:', error);
        await interaction.reply({ content: '❌ Failed to close ticket.', ephemeral: true });
    }
}

// ────────────────
// Startup: Deploy Commands and Login
// ────────────────
deployCommands();
client.login(process.env.BOT_TOKEN);
