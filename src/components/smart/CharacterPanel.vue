<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { characterService, type CharacterSkills } from '../../services/characterService';
import { eveAuthService } from '../../services/eveAuthService';
import { formattingService } from '../../services/formattingService';
import { marketDataService } from '../../services/marketDataService';
import { ordersService } from '../../services/ordersService';

const JITA_REGION = 10000002;
const JITA_SYSTEM = 30000142;

const emit = defineEmits<{
  (event: 'skills-loaded', skills: CharacterSkills): void;
}>();

const accounts = eveAuthService.accounts;
const character = eveAuthService.character;
const walletBalance = ordersService.walletBalance;
const skills = ref<CharacterSkills | undefined>(undefined);
const isLoading = ref(false);

const netWorth = computed(() => {
  const wallet = walletBalance.value;
  if (wallet === undefined) return undefined;
  void marketDataService.marketTick.value;
  const items = ordersService.inventoryItems.value;
  let assetsValue = 0;
  for (const item of items) {
    const jitaBuy = marketDataService.getHighestBuyPrice(JITA_REGION, item.typeId, JITA_SYSTEM);
    assetsValue += item.qty * (jitaBuy ?? item.avgBuyPrice);
  }
  let sellOrdersValue = 0;
  let escrowValue = 0;
  for (const o of ordersService.openOrders.value) {
    if (o.isBuyOrder) {
      escrowValue += o.escrow ?? 0;
    } else {
      sellOrdersValue += o.price * o.volumeRemain;
    }
  }
  return { total: wallet + assetsValue + sellOrdersValue + escrowValue, wallet, assetsValue, sellOrdersValue, escrowValue };
});

async function loadCharacterData(): Promise<void> {
  if (!character.value) return;
  isLoading.value = true;
  skills.value = undefined;
  try {
    const fetchedSkills = await characterService.getSkills();
    skills.value = fetchedSkills;
    if (fetchedSkills) emit('skills-loaded', fetchedSkills);
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  if (character.value) void loadCharacterData();
});

watch(() => character.value?.characterId, (newId) => {
  if (newId !== undefined) void loadCharacterData();
  else skills.value = undefined;
});

function login(): void {
  void eveAuthService.login();
}

function removeCharacter(characterId: number): void {
  if (characterId === eveAuthService.activeCharacterId.value) {
    ordersService.walletBalance.value = undefined;
    skills.value = undefined;
  }
  eveAuthService.removeCharacter(characterId);
}

function switchTo(characterId: number): void {
  eveAuthService.switchTo(characterId);
}
</script>

<template lang="pug">
.character-panel
  template(v-if="accounts.length === 0")
    button.login-btn(type="button" @click="login")
      img.eve-logo(src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-white-large.png" alt="Log in with EVE Online")

  template(v-else)
    .accounts-row
      .account-entry(
        v-for="acc in accounts"
        :key="acc.characterId"
        :class="{ 'account-entry--active': acc.characterId === character?.characterId }"
        @click="switchTo(acc.characterId)"
        :title="acc.characterName"
      )
        img.portrait(
          :src="`https://images.evetech.net/characters/${acc.characterId}/portrait?size=64`"
          :alt="acc.characterName"
        )
        button.remove-btn(type="button" @click.stop="removeCharacter(acc.characterId)" title="Remove character") ×
      button.add-btn(type="button" @click="login" title="Add another character") +

    .character-info(v-if="character")
      .details
        .char-name {{ character.characterName }}
        .wallet(v-if="walletBalance !== undefined")
          span.wallet-label Wallet:&nbsp;
          span.wallet-value {{ formattingService.isk(walletBalance) }}
        .wallet(v-if="netWorth !== undefined")
          span.wallet-label Net worth:&nbsp;
          span.wallet-value {{ formattingService.isk(netWorth.total) }}
          .nw-tooltip
            .nw-row
              span.nw-lbl Wallet
              span.nw-val {{ formattingService.isk(netWorth.wallet) }}
            .nw-row
              span.nw-lbl Inventory (Jita)
              span.nw-val {{ formattingService.isk(netWorth.assetsValue) }}
            .nw-row
              span.nw-lbl Sell orders
              span.nw-val {{ formattingService.isk(netWorth.sellOrdersValue) }}
            .nw-row
              span.nw-lbl Buy escrow
              span.nw-val {{ formattingService.isk(netWorth.escrowValue) }}
        .skills(v-if="skills")
          span.skill-badge Accounting {{ skills.accounting }}
          span.skill-badge Broker Relations {{ skills.brokerRelations }}
        .loading-hint(v-else-if="isLoading") Loading…
</template>

<style scoped lang="scss">
.character-panel {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.accounts-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.account-entry {
  border: 2px solid transparent;
  border-radius: 0.4rem;
  cursor: pointer;
  position: relative;
  transition: border-color 0.15s;

  &:hover {
    border-color: #4a6a8a;

    .remove-btn {
      opacity: 1;
    }
  }

  &--active {
    border-color: #64d7ff;
  }
}

.portrait {
  border-radius: 0.25rem;
  display: block;
  height: 40px;
  width: 40px;
}

.remove-btn {
  background: rgba(10, 18, 28, 0.88);
  border: none;
  border-radius: 50%;
  color: #ff8080;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 700;
  height: 16px;
  line-height: 16px;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: -4px;
  top: -4px;
  text-align: center;
  transition: opacity 0.15s;
  width: 16px;

  &:hover {
    background: rgba(200, 40, 40, 0.85);
    color: #fff;
    opacity: 1;
  }
}

.add-btn {
  align-items: center;
  background: rgba(100, 180, 255, 0.07);
  border: 1px dashed #2a4a6a;
  border-radius: 0.4rem;
  color: #4a7a9a;
  cursor: pointer;
  display: flex;
  font-size: 1.2rem;
  font-weight: 300;
  height: 40px;
  justify-content: center;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
  width: 40px;

  &:hover {
    background: rgba(100, 180, 255, 0.14);
    color: #64d7ff;
  }
}

.character-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.details {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.char-name {
  color: #ecf4ff;
  font-size: 0.9rem;
  font-weight: 600;
}

.wallet-label {
  color: #5e7a99;
  font-size: 0.75rem;
}

.wallet-value {
  color: #ffd96a;
  font-size: 0.75rem;
  font-weight: 600;
}

.wallet {
  position: relative;

  &:hover .nw-tooltip {
    display: block;
  }
}

.nw-tooltip {
  background: #0c1828;
  border: 1px solid #2a4a6a;
  border-radius: 0.4rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  display: none;
  left: 0;
  min-width: 220px;
  padding: 0.5rem 0.7rem;
  position: absolute;
  top: calc(100% + 4px);
  z-index: 100;
}

.nw-row {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  padding: 0.15rem 0;

  &+& {
    border-top: 1px solid #1a2e44;
  }
}

.nw-lbl {
  color: #5e7a99;
  font-size: 0.72rem;
  white-space: nowrap;
}

.nw-val {
  color: #ffd96a;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.skills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.skill-badge {
  background: rgba(100, 180, 255, 0.1);
  border-radius: 0.3rem;
  color: #64b4ff;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
}

.loading-hint {
  color: #5e7a99;
  font-size: 0.75rem;
}

.login-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;

  &:hover {
    opacity: 0.85;
  }
}

.eve-logo {
  display: block;
  height: 40px;
  width: auto;
}
</style>
