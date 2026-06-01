-- Outbound Engine Terminal Moderation
-- Place this Script in ServerScriptService.
-- Game Settings > Security > Allow HTTP Requests must be ON.

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local API_URL = "https://flwtzlcccumejmhbfjlh.functions.supabase.co/roblox-terminal"
local ENGINE_API_KEY = "SET_THIS_TO_OUTBOUND_ENGINE_KEY"

local COMMAND_POLL_INTERVAL = 2
local BAN_LIST_INTERVAL = 10
local RETRY_ATTEMPTS = 3
local DEBUG_MODE = true

local bannedUserIds = {}
local bannedDetails = {}

local function log(message)
	if DEBUG_MODE then
		print("[Outbound Engine] " .. message)
	end
end

local function post(action, payload)
	payload = payload or {}
	payload.action = action

	local body = HttpService:JSONEncode(payload)
	local lastError = nil

	for attempt = 1, RETRY_ATTEMPTS do
		local success, response = pcall(function()
			return HttpService:RequestAsync({
				Url = API_URL,
				Method = "POST",
				Headers = {
					["Content-Type"] = "application/json",
					["x-outbound-engine-key"] = ENGINE_API_KEY,
				},
				Body = body,
			})
		end)

		if success and response.Success then
			local parseSuccess, data = pcall(function()
				return HttpService:JSONDecode(response.Body)
			end)
			if parseSuccess then
				return true, data
			end
			lastError = "Could not parse API response"
		elseif success then
			lastError = "HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body)
		else
			lastError = tostring(response)
		end

		warn("[Outbound Engine] " .. action .. " attempt " .. attempt .. " failed: " .. tostring(lastError))
		task.wait(1)
	end

	return false, lastError
end

local function resolveUserId(username, providedUserId)
	if providedUserId and tonumber(providedUserId) then
		return tonumber(providedUserId), username
	end

	local success, userId = pcall(function()
		return Players:GetUserIdFromNameAsync(username)
	end)

	if success and userId then
		return userId, username
	end

	return nil, username
end

local function findPlayerByUserId(userId)
	for _, player in ipairs(Players:GetPlayers()) do
		if player.UserId == tonumber(userId) then
			return player
		end
	end
	return nil
end

local function kickPlayer(player, reason)
	local message = "BANNED FROM OUTBOUND\n\n"
	message = message .. "Player: " .. player.Name .. " (ID: " .. player.UserId .. ")\n"
	message = message .. "Reason: " .. (reason or "No reason provided") .. "\n\n"
	message = message .. "This action was enforced by the Outbound Engine."
	player:Kick(message)
end

local function refreshBanList()
	local ok, data = post("banned-users", {
		serverJobId = game.JobId,
		placeId = game.PlaceId,
	})

	if not ok or not data then
		warn("[Outbound Engine] Could not refresh banned users: " .. tostring(data))
		return
	end

	bannedUserIds = {}
	bannedDetails = {}

	for _, ban in ipairs(data.bans or {}) do
		local userId = tostring(ban.userId)
		bannedUserIds[userId] = true
		bannedDetails[userId] = ban
	end

	log("Ban list updated: " .. tostring(data.count or 0) .. " banned users")
end

local function acknowledge(command, status, message, userId, username)
	post("ack", {
		commandId = command.id,
		status = status,
		message = message,
		robloxUserId = userId,
		robloxUsername = username or command.robloxUsername,
		serverJobId = game.JobId,
		placeId = game.PlaceId,
	})
end

local function executeCommand(command)
	local action = tostring(command.action or "")
	local username = tostring(command.robloxUsername or "")
	local userId, resolvedUsername = resolveUserId(username, command.robloxUserId)

	if not userId then
		acknowledge(command, "failed", "Could not resolve Roblox username: " .. username, nil, username)
		return
	end

	if action == "ban" then
		bannedUserIds[tostring(userId)] = true
		bannedDetails[tostring(userId)] = {
			userId = userId,
			username = resolvedUsername,
			reason = command.reason or "Outbound Terminal ban",
		}

		local player = findPlayerByUserId(userId)
		if player then
			kickPlayer(player, command.reason or "Outbound Terminal ban")
			acknowledge(command, "completed", "Banned and kicked " .. player.Name, userId, resolvedUsername)
		else
			acknowledge(command, "completed", "Banned " .. resolvedUsername .. " (not currently in this server)", userId, resolvedUsername)
		end
		return
	end

	if action == "kick" then
		local player = findPlayerByUserId(userId)
		if player then
			player:Kick(command.reason or "You were kicked by Outbound staff.")
			acknowledge(command, "completed", "Kicked " .. player.Name, userId, resolvedUsername)
		else
			log(resolvedUsername .. " is not in this server; another server may complete the kick")
		end
		return
	end

	if action == "unban" then
		bannedUserIds[tostring(userId)] = nil
		bannedDetails[tostring(userId)] = nil
		acknowledge(command, "completed", "Unbanned " .. resolvedUsername, userId, resolvedUsername)
		return
	end

	acknowledge(command, "failed", "Unknown command action: " .. action, userId, resolvedUsername)
end

local function pollCommands()
	local ok, data = post("poll", {
		serverJobId = game.JobId,
		placeId = game.PlaceId,
	})

	if not ok or not data then
		warn("[Outbound Engine] Command poll failed: " .. tostring(data))
		return
	end

	for _, command in ipairs(data.commands or {}) do
		task.spawn(function()
			executeCommand(command)
		end)
	end
end

local function checkPlayerBan(player)
	local cached = bannedDetails[tostring(player.UserId)]
	if bannedUserIds[tostring(player.UserId)] then
		kickPlayer(player, cached and cached.reason or "Outbound Terminal ban")
		return
	end

	local ok, data = post("check-ban", {
		userId = player.UserId,
		serverJobId = game.JobId,
		placeId = game.PlaceId,
	})

	if ok and data and data.banned then
		bannedUserIds[tostring(player.UserId)] = true
		bannedDetails[tostring(player.UserId)] = data
		kickPlayer(player, data.reason or "Outbound Terminal ban")
	else
		log(player.Name .. " is clear")
	end
end

Players.PlayerAdded:Connect(function(player)
	task.spawn(function()
		checkPlayerBan(player)
	end)
end)

task.spawn(function()
	print("[Outbound Engine] Starting terminal moderation bridge")
	print("[Outbound Engine] API URL: " .. API_URL)
	print("[Outbound Engine] HTTP Requests must be enabled in Game Settings > Security")

	if ENGINE_API_KEY == "" or ENGINE_API_KEY == "SET_THIS_TO_OUTBOUND_ENGINE_KEY" then
		warn("[Outbound Engine] ENGINE_API_KEY is not configured. Paste the private Outbound engine key into this script.")
	end

	refreshBanList()

	for _, player in ipairs(Players:GetPlayers()) do
		task.spawn(function()
			checkPlayerBan(player)
		end)
	end

	local lastBanRefresh = os.clock()
	while true do
		pollCommands()

		if os.clock() - lastBanRefresh >= BAN_LIST_INTERVAL then
			refreshBanList()
			lastBanRefresh = os.clock()
		end

		task.wait(COMMAND_POLL_INTERVAL)
	end
end)
