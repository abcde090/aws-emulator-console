/**
 * Every service the console knows, by id. To add a service, write
 * src/services/<id>/def.ts and add it to SERVICES below. Server only.
 */

import { s3Service } from "../services/s3/def.ts";
import { sqsService } from "../services/sqs/def.ts";
import { ec2Service } from "../services/ec2/def.ts";
import { lambdaService } from "../services/lambda/def.ts";
import { ecsService } from "../services/ecs/def.ts";
import { eksService } from "../services/eks/def.ts";
import { elasticbeanstalkService } from "../services/elasticbeanstalk/def.ts";
import { vpcService } from "../services/vpc/def.ts";
import { route53Service } from "../services/route53/def.ts";
import { cloudfrontService } from "../services/cloudfront/def.ts";
import { apigatewayService } from "../services/apigateway/def.ts";
import { dynamodbService } from "../services/dynamodb/def.ts";
import { rdsService } from "../services/rds/def.ts";
import { elasticacheService } from "../services/elasticache/def.ts";
import { redshiftService } from "../services/redshift/def.ts";
import { dmsService } from "../services/dms/def.ts";
import { efsService } from "../services/efs/def.ts";
import { glacierService } from "../services/glacier/def.ts";
import { backupService } from "../services/backup/def.ts";
import { athenaService } from "../services/athena/def.ts";
import { glueService } from "../services/glue/def.ts";
import { kinesisService } from "../services/kinesis/def.ts";
import { snsService } from "../services/sns/def.ts";
import { eventbridgeService } from "../services/eventbridge/def.ts";
import { stepfunctionsService } from "../services/stepfunctions/def.ts";
import { iamService } from "../services/iam/def.ts";
import { identitycenterService } from "../services/identitycenter/def.ts";
import { kmsService } from "../services/kms/def.ts";
import { secretsmanagerService } from "../services/secretsmanager/def.ts";
import { acmService } from "../services/acm/def.ts";
import { cognitoService } from "../services/cognito/def.ts";
import { ramService } from "../services/ram/def.ts";
import { wafService } from "../services/waf/def.ts";
import { guarddutyService } from "../services/guardduty/def.ts";
import { securityhubService } from "../services/securityhub/def.ts";
import { configService } from "../services/config/def.ts";
import { cloudtrailService } from "../services/cloudtrail/def.ts";
import { cloudwatchService } from "../services/cloudwatch/def.ts";
import { xrayService } from "../services/xray/def.ts";
import { ssmService } from "../services/ssm/def.ts";
import { servicequotasService } from "../services/servicequotas/def.ts";
import { fisService } from "../services/fis/def.ts";
import { resiliencehubService } from "../services/resiliencehub/def.ts";
import { cloudformationService } from "../services/cloudformation/def.ts";
import { codebuildService } from "../services/codebuild/def.ts";
import { codecommitService } from "../services/codecommit/def.ts";
import { codepipelineService } from "../services/codepipeline/def.ts";
import { organizationsService } from "../services/organizations/def.ts";
import { costService } from "../services/cost/def.ts";
import { computeoptimizerService } from "../services/computeoptimizer/def.ts";
import { wellarchitectedService } from "../services/wellarchitected/def.ts";
import type { ResourceDef, ServiceDef } from "./types.ts";

/** Services with no resources yet are not built; they stay out of menus and routes. */
const ALL: readonly ServiceDef[] = [
  s3Service,
  sqsService,
  ec2Service,
  lambdaService,
  ecsService,
  eksService,
  elasticbeanstalkService,
  vpcService,
  route53Service,
  cloudfrontService,
  apigatewayService,
  dynamodbService,
  rdsService,
  elasticacheService,
  redshiftService,
  dmsService,
  efsService,
  glacierService,
  backupService,
  athenaService,
  glueService,
  kinesisService,
  snsService,
  eventbridgeService,
  stepfunctionsService,
  iamService,
  identitycenterService,
  kmsService,
  secretsmanagerService,
  acmService,
  cognitoService,
  ramService,
  wafService,
  guarddutyService,
  securityhubService,
  configService,
  cloudtrailService,
  cloudwatchService,
  xrayService,
  ssmService,
  servicequotasService,
  fisService,
  resiliencehubService,
  cloudformationService,
  codebuildService,
  codecommitService,
  codepipelineService,
  organizationsService,
  costService,
  computeoptimizerService,
  wellarchitectedService,
];

export const SERVICES: readonly ServiceDef[] = ALL.filter((s) => s.resources.length > 0);

export interface ServiceSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  firstResource: string | null;
}

export function getService(id: string): ServiceDef | null {
  return SERVICES.find((s) => s.id === id) ?? null;
}

export function getResource(serviceId: string, resourceId: string): ResourceDef | null {
  return getService(serviceId)?.resources.find((r) => r.id === resourceId) ?? null;
}

/** What the shell's services menu, search and Console Home show. */
export function serviceCatalog(): ServiceSummary[] {
  return SERVICES.map((s) => ({ id: s.id, name: s.name, category: s.category, description: s.description, firstResource: s.resources[0]?.id ?? null }));
}
