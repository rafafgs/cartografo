/**
 * Rotas de grafo e de versão de grafo (t101, FR5/FR6).
 *
 * `POST /grafos` é o caminho que faz o grafo virar DADO: o mesmo documento
 * `grafo.json` do bundle de fábrica entra cru, passa pelo portão de validação e
 * vira linhagem + primeira versão. É o critério "grafo vivendo como dado no
 * banco (não como código)" da D16.
 *
 * O corpo é o documento de grafo puro, sem envelope. Não há schema Fastify/ajv
 * declarado contra `schema/grafo.schema.json`: o schema do t96 é draft 2020-12
 * e o ajv que vem no Fastify v5 está configurado para draft-07. Em vez de
 * reconfigurar o compilador, o portão é o par `validarEstrutura`/`validarSoundness`
 * chamado no handler — que é o mesmo julgamento que uma proposta sofre ao ser
 * aplicada, e por isso não pode divergir dele.
 *
 * Nenhuma rota daqui emite evento de telemetria: a tabela append-only de
 * eventos é do t102. Os nomes de campo já são os dos schemas de
 * `grafo_versao.*`, para que a emissão futura seja mapeamento direto.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { validarGrafo, type DocumentoGrafo } from '../dominio/grafo.ts';
import {
  buscarBaseDaClasse,
  buscarGrafo,
  buscarVersao,
  listarClasses,
  listarGrafos,
  listarVersoes,
  registrarGrafoBase,
} from '../repositorios/grafos.ts';

interface ParametroId {
  Params: { id: string };
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Registra as rotas de grafo no escopo recebido (que já vem com o prefixo /v1).
 *
 * @param app Escopo do Fastify.
 * @param db Banco já aberto; as rotas nunca abrem o seu (D1).
 */
export function registrarGrafos(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/grafos', async (requisicao, resposta) => {
    const documento = requisicao.body;

    const relatorio = validarGrafo(documento);
    if (!relatorio.valido) {
      resposta.code(422);
      return { erro: 'grafo_invalido', ...relatorio };
    }

    // O documento passou no portão, então é um objeto com as sete chaves; falta
    // só garantir que `classe` serve de identidade (D8: id da linhagem = classe).
    const bruto = documento as Record<string, unknown>;
    const classe = bruto.classe;
    if (typeof classe !== 'string' || classe.trim() === '') {
      resposta.code(422);
      return {
        erro: 'grafo_invalido',
        valido: false,
        estrutura: {
          valido: false,
          erros: [
            {
              codigo: 'campo_invalido',
              mensagem: '"classe" precisa ser um texto preenchido: é a identidade da linhagem (D8)',
              alvo: 'classe',
            },
          ],
        },
        soundness: relatorio.soundness,
      };
    }

    const linhagem = ehObjeto(bruto.linhagem) ? bruto.linhagem : {};
    if (linhagem.tipo !== 'base') {
      resposta.code(400);
      return {
        erro: 'linhagem_nao_base',
        mensagem:
          'esta rota registra apenas grafo base; variante nasce de fork com proposta (D13, t118)',
        linhagem_tipo: linhagem.tipo ?? null,
      };
    }

    if (buscarBaseDaClasse(db, classe) !== undefined) {
      resposta.code(409);
      return {
        erro: 'classe_ja_registrada',
        mensagem: `a classe "${classe}" já tem um grafo base; versão nova sobre linhagem existente é fluxo de proposta`,
        classe,
      };
    }

    const { grafo, versao } = registrarGrafoBase(db, documento as DocumentoGrafo);
    resposta.code(201);
    return { grafo, grafo_versao: versao };
  });

  app.get('/classes', async () => ({ classes: listarClasses(db) }));

  app.get('/grafos', async () => ({ grafos: listarGrafos(db) }));

  app.get<ParametroId>('/grafos/:id', async (requisicao, resposta) => {
    const grafo = buscarGrafo(db, requisicao.params.id);
    if (grafo === undefined) {
      resposta.code(404);
      return { erro: 'grafo_desconhecido', id: requisicao.params.id };
    }
    return { grafo };
  });

  // A cadeia inteira, inclusive versões abandonadas por reversão: é o histórico
  // íntegro que a D15 promete, não só o caminho que sobreviveu.
  app.get<ParametroId>('/grafos/:id/versoes', async (requisicao, resposta) => {
    const grafo = buscarGrafo(db, requisicao.params.id);
    if (grafo === undefined) {
      resposta.code(404);
      return { erro: 'grafo_desconhecido', id: requisicao.params.id };
    }
    return { versoes: listarVersoes(db, grafo.id) };
  });

  app.get<ParametroId>('/grafo-versoes/:id', async (requisicao, resposta) => {
    const versao = buscarVersao(db, requisicao.params.id);
    if (versao === undefined) {
      resposta.code(404);
      return { erro: 'grafo_versao_desconhecida', id: requisicao.params.id };
    }
    return { grafo_versao: versao };
  });
}
