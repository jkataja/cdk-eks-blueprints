import * as assert from "assert";
import { CfnOutput, Duration, Names } from 'aws-cdk-lib';
import { Cluster, KubernetesVersion, IpFamily } from 'aws-cdk-lib/aws-eks';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from "constructs";
import * as semver from 'semver';
import { merge } from 'ts-deepmerge';
import * as md5 from 'ts-md5';
import { ClusterInfo } from '../../spi';
import * as utils from '../../utils';

import { HelmAddOn, HelmAddOnProps, HelmAddOnUserProps } from '../helm-addon';
import { KarpenterControllerPolicy, KarpenterControllerPolicyBeta } from './iam';
import { Ec2NodeClassSpec, KARPENTER, NodePoolSpec, RELEASE } from "./types";

export * from "./types";
export * from './karpenter-v1';

class versionMap {
    private static readonly versionMap: Map<string, string> = new Map([
        [KubernetesVersion.V1_31.version, '0.37.5'],
        [KubernetesVersion.V1_30.version, '0.37.5'],
        [KubernetesVersion.V1_29.version, '0.34.0'],
        [KubernetesVersion.V1_28.version, '0.31.0'],
        [KubernetesVersion.V1_27.version, '0.28.0'],
        [KubernetesVersion.V1_26.version, '0.28.0'],
        [KubernetesVersion.V1_25.version, '0.25.0'],
        [KubernetesVersion.V1_24.version, '0.21.0'],
        [KubernetesVersion.V1_23.version, '0.21.0'],
    ]);
    public static has(version: KubernetesVersion) {
      return this.versionMap.has(version.version);
    }
    public static get(version: KubernetesVersion) {
      return this.versionMap.get(version.version);
    }
  }

/**
 * Configuration options for the add-on
 */
export interface KarpenterAddOnProps extends HelmAddOnUserProps {
    /**
     * This is the top level nodepool specification. Nodepools launch nodes in response to pods that are unschedulable.
     * A single nodepool is capable of managing a diverse set of nodes.
     * Node properties are determined from a combination of nodepool and pod scheduling constraints.
     */
    nodePoolSpec?: NodePoolSpec,

    /**
     * This is the top level spec for the AWS Karpenter Provider
     * It contains configuration necessary to launch instances in AWS.
     */
    ec2NodeClassSpec?: Ec2NodeClassSpec,

    /**
     * Flag for enabling Karpenter's native interruption handling
     */
    interruptionHandling?: boolean,

    /*
    * Flag for managing install of Karpenter's new CRDs between versions
    * This is only necessary if upgrading from a version prior to v0.32.0
    * If not provided, defaults to true
    * If set to true, the add-on will manage installation of the CRDs
    */
    installCRDs?: boolean,
    /**
     * Timeout duration while installing karpenter helm chart using addHelmChart API
     */
    helmChartTimeout?: Duration,

    /**
     * Use Pod Identity.
     * To use EKS Pod Identities
     *  - The cluster must have Kubernetes version 1.24 or later
     *  - Karpenter Pods must be assigned to Linux Amazon EC2 instances
     *  - Karpenter version supports Pod Identity (v0.35.0 or later) see https://docs.aws.amazon.com/eks/latest/userguide/pod-identity.html
     *
     * @see https://docs.aws.amazon.com/eks/latest/userguide/pod-identity.html
     *
     * @default false
     */
    podIdentity?: boolean,
}


/**
 * Defaults options for the add-on
 */
const defaultProps: HelmAddOnProps = {
    name: KARPENTER,
    namespace: "kube-system",
    version: '1.0.6',
    chart: KARPENTER,
    release: KARPENTER,
    repository: 'oci://public.ecr.aws/karpenter/karpenter',
};

/**
 * Implementation of the Karpenter add-on.
 * @deprecated use KarpenterV1AddOn moving forward
 */
@utils.supportsALL
export class KarpenterAddOn extends HelmAddOn {

    readonly options: KarpenterAddOnProps;

    constructor(props?: KarpenterAddOnProps) {
        super({...defaultProps, ...props});
        this.options = this.props;
    }

    @utils.conflictsWith('ClusterAutoScalerAddOn')
    deploy(clusterInfo: ClusterInfo): Promise<Construct> {
        assert(clusterInfo.cluster instanceof Cluster, "KarpenterAddOn cannot be used with imported clusters as it requires changes to the cluster authentication.");
        const cluster : Cluster = clusterInfo.cluster;
        const endpoint = cluster.clusterEndpoint;
        const name = cluster.clusterName;
        const partition = cluster.stack.partition;

        const stackName = cluster.stack.stackName;
        const region = cluster.stack.region;

        let values = this.options.values ?? {};
        const version = this.options.version!;

        const interruption = this.options.interruptionHandling || false;
        const installCRDs = this.options.installCRDs || false;

        const podIdentity = this.options.podIdentity || false;

        // NodePool variables
        const labels = this.options.nodePoolSpec?.labels || {};
        const annotations = this.options.nodePoolSpec?.annotations || {};
        const taints = this.options.nodePoolSpec?.taints || [];
        const startupTaints = this.options.nodePoolSpec?.startupTaints || [];
        const requirements = this.options.nodePoolSpec?.requirements || [];
        const consol = this.options.nodePoolSpec?.consolidation || null;
        const ttlSecondsAfterEmpty = this.options.nodePoolSpec?.ttlSecondsAfterEmpty || null;
        const ttlSecondsUntilExpired = this.options.nodePoolSpec?.ttlSecondsUntilExpired || null;
        const disruption = this.options.nodePoolSpec?.disruption || null;
        const limits = this.options.nodePoolSpec?.limits || null;
        const weight = this.options.nodePoolSpec?.weight || null;

        // NodeClass variables
        const subnetSelector = this.options.ec2NodeClassSpec?.subnetSelector;
        const sgSelector = this.options.ec2NodeClassSpec?.securityGroupSelector;
        const subnetSelectorTerms = this.options.ec2NodeClassSpec?.subnetSelectorTerms;
        const sgSelectorTerms = this.options.ec2NodeClassSpec?.securityGroupSelectorTerms;
        const amiFamily = this.options.ec2NodeClassSpec?.amiFamily;
        const amiSelector = this.options.ec2NodeClassSpec?.amiSelector || {};
        const amiSelectorTerms = this.options.ec2NodeClassSpec?.amiSelectorTerms;
        const instanceStorePolicy = this.options.ec2NodeClassSpec?.instanceStorePolicy || undefined;
        const userData = this.options.ec2NodeClassSpec?.userData || "";
        const instanceProf = this.options.ec2NodeClassSpec?.instanceProfile;
        const tags = this.options.ec2NodeClassSpec?.tags || {};
        const metadataOptions = this.options.ec2NodeClassSpec?.metadataOptions || {
            httpEndpoint: "enabled",
            httpProtocolIPv6: "disabled",
            httpPutResponseHopLimit: 2,
            httpTokens: "required"
        };
        if (cluster.ipFamily == IpFamily.IP_V6) {
            metadataOptions.httpProtocolIPv6 = "enabled";
        }
        const blockDeviceMappings = this.options.ec2NodeClassSpec?.blockDeviceMappings || [];
        const detailedMonitoring = this.options.ec2NodeClassSpec?.detailedMonitoring || false;

        // Check Kubernetes and Karpenter version compatibility for warning
        this.isCompatible(version, clusterInfo.version);

        // Version feature checks for errors
        this.versionFeatureChecksForError(clusterInfo, version, disruption, consol, ttlSecondsAfterEmpty, ttlSecondsUntilExpired,
            this.options.ec2NodeClassSpec, amiFamily);

        // Set up the node role and instance profile
        const [karpenterNodeRole, karpenterInstanceProfile] = this.setUpNodeRole(cluster, stackName, region);

        // Create the controller policy
        let karpenterPolicyDocument;
        if (semver.gte(version, "v0.32.0")){
            karpenterPolicyDocument = iam.PolicyDocument.fromJson(KarpenterControllerPolicyBeta(cluster, partition, region));
        } else {
            karpenterPolicyDocument = iam.PolicyDocument.fromJson(KarpenterControllerPolicy);
        }
        karpenterPolicyDocument.addStatements(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "iam:PassRole",
            ],
            resources: [`${karpenterNodeRole.roleArn}`]
        }));

        // Support for Native spot interruption
        if (interruption){
            // Create Interruption Queue
            const queue = new sqs.Queue(cluster.stack, 'karpenter-queue', {
                queueName: stackName,
                retentionPeriod: Duration.seconds(300),
            });
            queue.addToResourcePolicy(new iam.PolicyStatement({
                sid: 'EC2InterruptionPolicy',
                effect: iam.Effect.ALLOW,
                principals: [
                    new iam.ServicePrincipal('sqs.amazonaws.com'),
                    new iam.ServicePrincipal('events.amazonaws.com'),
                ],
                actions: [
                    "sqs:SendMessage"
                ],
                resources: [`${queue.queueArn}`]
            }));

            // Add Interruption Rules
            new Rule(cluster.stack, 'schedule-change-rule', {
                eventPattern: {
                    source: ["aws.health"],
                    detailType: ['AWS Health Event']
                },
            }).addTarget(new SqsQueue(queue));

            new Rule(cluster.stack, 'spot-interruption-rule', {
                eventPattern: {
                    source: ["aws.ec2"],
                    detailType: ['EC2 Spot Instance Interruption Warning']
                },
            }).addTarget(new SqsQueue(queue));

            new Rule(cluster.stack, 'rebalance-rule', {
                eventPattern: {
                    source: ["aws.ec2"],
                    detailType: ['EC2 Instance Rebalance Recommendation']
                },
            }).addTarget(new SqsQueue(queue));

            new Rule(cluster.stack, 'inst-state-change-rule', {
                eventPattern: {
                    source: ["aws.ec2"],
                    detailType: ['C2 Instance State-change Notification']
                },
            }).addTarget(new SqsQueue(queue));

            // Add policy to the node role to allow access to the Interruption Queue
            const interruptionQueueStatement = new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "sqs:DeleteMessage",
                    "sqs:GetQueueUrl",
                    "sqs:GetQueueAttributes",
                    "sqs:ReceiveMessage"
                ],
                resources: [`${queue.queueArn}`]
            });
            karpenterPolicyDocument.addStatements(interruptionQueueStatement);
        }

        // Create Namespace
        const ns = utils.createNamespace(this.options.namespace!, cluster, true, true);

        let sa: any;
        let saAnnotation: any;
        if (podIdentity && semver.gte(`${clusterInfo.version.version}.0`, '1.24.0') && semver.gte(version, "v0.35.0")){
          sa = utils.podIdentityAssociation(cluster, RELEASE, this.options.namespace!, karpenterPolicyDocument);
          saAnnotation = {};
        } else {
          sa = utils.createServiceAccount(cluster, RELEASE, this.options.namespace!, karpenterPolicyDocument);
          saAnnotation = {"eks.amazonaws.com/role-arn": sa.role.roleArn};
        }
        sa.node.addDependency(ns);

        // Create global helm values based on v1beta1 migration as shown below:
        // https://karpenter.sh/v0.32/upgrading/v1beta1-migration/#helm-values
        let globalSettings = {
            clusterName: name,
            clusterEndpoint: endpoint
        };

        if (semver.lt(version, '0.32.0')){
            globalSettings = merge(globalSettings, {
                defaultInstanceProfile: karpenterInstanceProfile.instanceProfileName,
                interruptionQueueName: interruption ? stackName : ""
            });
        } else {
            globalSettings = merge(globalSettings, {
                interruptionQueue: interruption ? stackName : ""
            });
        }

        if (semver.lt(version, '0.32.0')){
            utils.setPath(values, "settings.aws", merge(globalSettings, values?.settings?.aws ?? {}));
        } else {
            utils.setPath(values, "settings", merge(globalSettings, values?.settings ?? {}));
        }

        // Let Helm create the service account if using pod identity
        const saValues = {
            serviceAccount: {
                create: podIdentity,
                name: RELEASE,
                annotations: saAnnotation,
            }
        };

        values = merge(values, saValues);
        // Install HelmChart using user defined value or default of 5 minutes.
        const helmChartTimeout = this.options.helmChartTimeout || Duration.minutes(5);
        const karpenterChart = this.addHelmChart(clusterInfo, values, false, true, helmChartTimeout);

        karpenterChart.node.addDependency(sa);

        if(clusterInfo.nodeGroups) {
            clusterInfo.nodeGroups.forEach(n => karpenterChart.node.addDependency(n));
        }

        if (semver.gte(version, "0.32.0") && installCRDs){
            let _version = version;
            if(!version.startsWith('v')) {
                _version = `v${version}`;
            }

            const CRDs =[
                [ "karpentersh-nodepool-beta1-crd", `https://raw.githubusercontent.com/aws/karpenter/${_version}/pkg/apis/crds/karpenter.sh_nodepools.yaml` ],
                [ "karpentersh-nodeclaims-beta1-crd", `https://raw.githubusercontent.com/aws/karpenter/${_version}/pkg/apis/crds/karpenter.sh_nodeclaims.yaml`],
                [ "karpenterk8s-ec2nodeclasses-beta1-crd", `https://raw.githubusercontent.com/aws/karpenter/${_version}/pkg/apis/crds/karpenter.k8s.aws_ec2nodeclasses.yaml`],
            ];

            // loop over the CRD's and load the yaml and deploy the manifest
            for (const [crdName, crdUrl] of CRDs) {
                const crdManifest = utils.loadExternalYaml(crdUrl);
                const manifest = cluster.addManifest(crdName, crdManifest);

                // We want these installed before the karpenterChart, or helm will timeout waiting for it to stabilize
                karpenterChart.node.addDependency(manifest);
            }
        }


        // Deploy Provisioner (Alpha) or NodePool (Beta) CRD based on the Karpenter Version
        if (this.options.nodePoolSpec){
            let pool;
            if (semver.gte(version, '0.32.0')){
                pool = {
                    apiVersion: 'karpenter.sh/v1beta1',
                    kind: 'NodePool',
                    metadata: { name: 'default-nodepool' },
                    spec: {
                        template: {
                            metadata: {
                                labels: labels,
                                annotations: annotations,
                            },
                            spec: {
                                nodeClassRef: {
                                    name: "default-ec2nodeclass"
                                },
                                taints: taints,
                                startupTaints: startupTaints,
                                requirements: this.convert(requirements),
                            }
                        },
                        disruption: disruption,
                        limits: limits,
                        weight: weight,
                    },
                };
            } else {
                pool = {
                    apiVersion: 'karpenter.sh/v1alpha5',
                    kind: 'Provisioner',
                    metadata: { name: 'default-provisioner' },
                    spec: {
                        providerRef: {
                            name: "default-nodetemplate"
                        },
                        taints: taints,
                        startupTaints: startupTaints,
                        labels: labels,
                        annotations: annotations,
                        requirements: this.convert(requirements),
                        limits: {
                            resources: limits,
                        },
                        consolidation: consol,
                        ttlSecondsUntilExpired: ttlSecondsUntilExpired,
                        ttlSecondsAfterEmpty: ttlSecondsAfterEmpty,
                        weight: weight,
                    },
                };
            }
            const poolManifest = cluster.addManifest('default-pool', pool);
            poolManifest.node.addDependency(karpenterChart);

            // Deploy AWSNodeTemplate (Alpha) or EC2NodeClass (Beta) CRD based on the Karpenter Version
            if (this.options.ec2NodeClassSpec){
                let ec2Node;
                if (semver.gte(version, '0.32.0')){
                    ec2Node = {
                        apiVersion: "karpenter.k8s.aws/v1beta1",
                        kind: "EC2NodeClass",
                        metadata: {
                            name: "default-ec2nodeclass"
                        },
                        spec: {
                            amiFamily: amiFamily,
                            subnetSelectorTerms: subnetSelectorTerms,
                            securityGroupSelectorTerms: sgSelectorTerms,
                            amiSelectorTerms: amiSelectorTerms,
                            userData: userData,
                            tags: tags,
                            metadataOptions: metadataOptions,
                            blockDeviceMappings: blockDeviceMappings,
                            detailedMonitoring: detailedMonitoring,
                        },
                    };

                    // Provide custom Instance Profile to replace role if provided, else use the role created with the addon
                    if (instanceProf) {
                        ec2Node = merge(ec2Node, { spec: { instanceProfile: instanceProf }});
                    } else {
                        ec2Node = merge(ec2Node, { spec: { role: karpenterNodeRole.roleName }});
                    }

                    // Instance Store Policy added for v0.34.0 and up
                    if (semver.gte(version, '0.34.0') && instanceStorePolicy){
                        ec2Node = merge(ec2Node, { spec: { instanceStorePolicy: instanceStorePolicy }});
                    }
                } else {
                    ec2Node = {
                        apiVersion: "karpenter.k8s.aws/v1alpha1",
                        kind: "AWSNodeTemplate",
                        metadata: {
                            name: "default-nodetemplate"
                        },
                        spec: {
                            subnetSelector: subnetSelector,
                            securityGroupSelector: sgSelector,
                            instanceProfile: instanceProf ? instanceProf : null,
                            amiFamily: amiFamily ? amiFamily : "AL2",
                            amiSelector: amiSelector,
                            tags: tags,
                            metadataOptions: metadataOptions,
                            blockDeviceMappings: blockDeviceMappings,
                            userData: userData,
                        },
                    };

                    // Add EC2 Detailed Monitoring for v0.22.0 and up
                    if (semver.gte(version, '0.22.0')){
                        ec2Node = merge(ec2Node, { spec: { detailedMonitoring: detailedMonitoring}});
                    }
                }
                const nodeManifest = cluster.addManifest('default-node-template', ec2Node);
                nodeManifest.node.addDependency(poolManifest);
            }
        }

        return Promise.resolve(karpenterChart);
    }

    /**
     * Helper function to convert a key-pair values (with an operator)
     * of spec configurations to appropriate json format for addManifest function
     * @param reqs
     * @returns newReqs
     * */
    protected convert(reqs: {key: string, operator: string, values: string[]}[]): any[] {
        const newReqs = [];
        for (let req of reqs){
            const key = req['key'];
            const op = req['operator'];
            const val = req['values'];
            const requirement = {
                "key": key,
                "operator": op,
                "values": val
            };
            newReqs.push(requirement);
        }
        return newReqs;
    }

    /**
     * Helper function to ensure right features are added as part of the configuration
     * for the right version of the add-on
     * @param clusterInfo
     * @param version version of the add-on
     * @param disruption disruption feature available with the Beta CRDs
     * @param consolidation consolidation setting available with the Alpha CRDs
     * @param ttlSecondsAfterEmpty ttlSecondsAfterEmpty setting
     * @param ttlSecondsUntilExpired ttlSecondsUntilExpired setting
     * @param ec2NodeClassSpec Node Class Spec
     * @param amiFamily AMI Family
     * @returns
     */
    private versionFeatureChecksForError(clusterInfo: ClusterInfo, version: string, disruption: any, consolidation: any, ttlSecondsAfterEmpty: any, ttlSecondsUntilExpired: any,
        ec2NodeClassSpec: any, amiFamily: any): void {

        // EC2 Detailed Monitoring is only available in versions 0.23.0 and above
        if (semver.lt(version, '0.23.0') && ec2NodeClassSpec){
            assert(ec2NodeClassSpec["detailedMonitoring"] === undefined, "Detailed Monitoring is not available in this version of Karpenter. Please upgrade to at least 0.23.0.");
        }

        // Disruption budget should not exist for versions below 0.34.x
        if (semver.lt(version, '0.34.0')){
            if (disruption){
                assert(!disruption["budgets"], "You cannot set disruption budgets for this version of Karpenter. Please upgrade to 0.34.0 or higher.");
            }
        }

        // version check errors for v0.32.0 and up (beta CRDs)
        if (semver.gte(version, '0.32.0')){
            // Consolidation features don't exist in beta CRDs
            assert(!consolidation && !ttlSecondsAfterEmpty && !ttlSecondsUntilExpired, 'Consolidation features are only available for previous versions of Karpenter.');

            // consolidateAfter cannot be set if policy is set to WhenUnderutilized
            if (disruption && disruption["consolidationPolicy"] == "WhenUnderutilized"){
                assert(!disruption["consolidateAfter"], 'You cannot set consolidateAfter value if the consolidation policy is set to Underutilized.');
            }

            // AMI Family, Security Group and Subnet terms must be provided, given EC2 NodeSpec
            if (ec2NodeClassSpec){
                assert(amiFamily !== undefined, "Please provide the AMI Family for your EC2NodeClass.");
                assert(ec2NodeClassSpec["securityGroupSelectorTerms"] !== undefined, "Please provide SecurityGroupTerm for your EC2NodeClass.");
                assert(ec2NodeClassSpec["subnetSelectorTerms"] !== undefined, "Please provide subnetGroupTerm for your EC2NodeClass.");
            }
        }

        // version check errors for v0.31.x and down (alpha CRDs)
        // Includes checks for consolidation and disruption features
        if (semver.lt(version, '0.32.0')){
            if (consolidation){
                assert(!(consolidation.enabled && ttlSecondsAfterEmpty) , 'Consolidation and ttlSecondsAfterEmpty must be mutually exclusive.');
            }
            assert(!disruption, 'Disruption configuration is only supported on versions v0.32.0 and later.');

            //Security Group and Subnet terms must be provided, given EC2 NodeSpec
            if (ec2NodeClassSpec){
                assert(ec2NodeClassSpec["securityGroupSelector"] !== undefined, "Please provide SecurityGroupTerm for your AWSNodeTemplate.");
                assert(ec2NodeClassSpec["subnetSelector"] !== undefined, "Please provide subnetGroupTerm for your AWSNodeTemplate.");
            }
        }

        // We should block Node Termination Handler usage once Karpenter is leveraged
         assert(!clusterInfo.getProvisionedAddOn('AwsNodeTerminationHandlerAddOn'), 'Karpenter supports native interruption handling, so Node Termination Handler will not be necessary.');

    }

    /**
     * Helper function to set up the Karpenter Node Role and Instance Profile
     * Outputs to CloudFormation and map the role to the aws-auth ConfigMap
     * @param cluster EKS Cluster
     * @param stackName Name of the stack
     * @param region Region of the stack
     * @returns [karpenterNodeRole, karpenterInstanceProfile]
     */
    private setUpNodeRole(cluster: Cluster, stackName: string, region: string): [iam.Role, iam.CfnInstanceProfile] {
        // Set up Node Role
        const karpenterNodeRole = new iam.Role(cluster, 'karpenter-node-role', {
            assumedBy: new iam.ServicePrincipal(`ec2.${cluster.stack.urlSuffix}`),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
            ],
            //roleName: `KarpenterNodeRole-${name}` // let role name to be generated as unique
        });

        // Attach ipv6 related policies based on cluster IPFamily
        if (cluster.ipFamily === IpFamily.IP_V6){
            const nodeIpv6Policy = new iam.Policy(cluster, 'karpenter-node-Ipv6-Policy', {
                document: utils.getEKSNodeIpv6PolicyDocument() });
            karpenterNodeRole.attachInlinePolicy(nodeIpv6Policy);
        }

        // Set up Instance Profile
        const instanceProfileName = md5.Md5.hashStr(stackName+region);
        const karpenterInstanceProfile = new iam.CfnInstanceProfile(cluster, 'karpenter-instance-profile', {
            roles: [karpenterNodeRole.roleName],
            instanceProfileName: `KarpenterNodeInstanceProfile-${instanceProfileName}`,
            path: '/'
        });
        karpenterInstanceProfile.node.addDependency(karpenterNodeRole);

        const clusterId = Names.uniqueId(cluster);

        //Cfn output for Node Role in case of needing to add additional policies
        new CfnOutput(cluster.stack, 'Karpenter Instance Node Role', {
            value: karpenterNodeRole.roleName,
            description: "Karpenter add-on Node Role name",
            exportName: clusterId+"KarpenterNodeRoleName",
        });
        //Cfn output for Instance Profile for creating additional provisioners
        new CfnOutput(cluster.stack, 'Karpenter Instance Profile name', {
            value: karpenterInstanceProfile ? karpenterInstanceProfile.instanceProfileName! : "none",
            description: "Karpenter add-on Instance Profile name",
            exportName: clusterId+"KarpenterInstanceProfileName",
        });

        // Map Node Role to aws-auth
        cluster.awsAuth.addRoleMapping(karpenterNodeRole, {
            groups: ['system:bootstrapper', 'system:nodes'],
            username: 'system:node:{{EC2PrivateDNSName}}'
        });

        return [karpenterNodeRole, karpenterInstanceProfile];
    }

    /**
     * Helper function to check whether:
     * 1. Supported Karpenter versions are implemented, and
     * 2. Supported Kubernetes versions are deployed on the cluster to use Karpenter
     * It will reject the addon if the cluster uses deprecated Kubernetes version, and
     * Warn users about issues if incompatible Karpenter version is used for a particular cluster
     * given its Kubernetes version
     * @param karpenterVersion Karpenter version to be deployed
     * @param kubeVersion Cluster's Kubernetes version
     */
    private isCompatible(karpenterVersion: string, kubeVersion: KubernetesVersion): void {
        assert(versionMap.has(kubeVersion), 'Please upgrade your EKS Kubernetes version to start using Karpenter.');
        assert(semver.gte(karpenterVersion, '0.21.0'), 'Please use Karpenter version 0.21.0 or above.');
        const compatibleVersion = versionMap.get(kubeVersion) as string;
        if (semver.gt(compatibleVersion, karpenterVersion)) {
            console.warn(`Please use minimum Karpenter version for this Kubernetes Version: ${compatibleVersion}, otherwise you will run into compatibility issues.`);
        }
    }
}
