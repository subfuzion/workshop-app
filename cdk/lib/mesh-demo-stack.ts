import {CfnMesh, CfnRoute, CfnVirtualNode, CfnVirtualRouter, CfnVirtualService} from "@aws-cdk/aws-appmesh";
import {Port, SecurityGroup, SubnetType, Vpc} from "@aws-cdk/aws-ec2";
import {Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDriver} from "@aws-cdk/aws-ecs";
import {ApplicationLoadBalancer} from "@aws-cdk/aws-elasticloadbalancingv2";
import {ManagedPolicy, Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import {LogGroup, RetentionDays} from "@aws-cdk/aws-logs";
import {CfnOutput, Construct, Duration, RemovalPolicy, Stack, StackProps} from "@aws-cdk/core";

/**
 * Deploys the resources necessary to demo the Color App *before* and *after* enabling App Mesh.
 * This stack deploys
 * - a vpc with private subnets in 2 AZs, and a public ALB
 * - the Color App (a gateway and two colorteller (blue & green) services)
 * - an App Mesh mesh (ready to go for mesh-enabling the app)
 */
export class MeshDemoStack extends Stack {

  // Demo customization
  //
  // Gateway
  // You can use either either of these:
  // - "226767807331.dkr.ecr.us-west-2.amazonaws.com/gateway:latest"
  // - "subfuzion/colorgateway:v2"
  // - your own image on Docker Hub or ECR for your own account
  readonly GatewayImage = "subfuzion/colorgateway:v2";

  // ColorTeller
  // You can use either either of these:
  // - "226767807331.dkr.ecr.us-west-2.amazonaws.com/colorteller:latest"
  // - "subfuzion/colorteller:v2"
  // - your own image on Docker Hub or ECR for your own account
  readonly ColorTellerImage = "subfuzion/colorteller:v2";

  // Gateway and ColorTeller server port
  readonly APP_PORT = 8080;

  // ColorTeller services to run
  readonly colors = ["blue", "green"];

  // service domain / namespace
  readonly namespace: string = "mesh.local";

  // might want to experiment with different ttl during testing
  readonly DEF_TTL = Duration.seconds(10);
  //
  // end: Demo customization


  stackName: string;
  taskRole: Role;
  taskExecutionRole: Role;
  vpc: Vpc;
  cluster: Cluster;
  internalSecurityGroup: SecurityGroup;
  externalSecurityGroup: SecurityGroup;
  logGroup: LogGroup;
  mesh: CfnMesh;


  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // store for convenience
    this.stackName = props && props.stackName ? props.stackName : "demo";

    this.createLogGroup();
    this.createVpc();
    this.createCluster();
    this.createGateway();
    this.createColorTeller(...this.colors);
    this.createMesh();
  }

  createLogGroup() {
    this.logGroup = new LogGroup(this, "LogGroup", {
      logGroupName: this.stackName,
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  createVpc() {
    // The VPC will have 2 AZs, 2 NAT gateways, and an internet gateway
    this.vpc = new Vpc(this, "VPC", {
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "ingress",
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "application",
          subnetType: SubnetType.PRIVATE,
        },
      ],
    });

    // Allow public inbound web traffic on port 80
    this.externalSecurityGroup = new SecurityGroup(this, "ExternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    this.externalSecurityGroup.connections.allowFromAnyIpv4(Port.tcp(80));

    // Allow communication within the vpc for the app and envoy containers
    // inbound 8080, 9901, 15000; all outbound
    // - 8080: default app port for gateway and colorteller
    // - 9901: envoy admin interface, used for health check
    // - 15000: envoy ingress ports (egress over 15001 will be allowed by allowAllOutbound)
    this.internalSecurityGroup = new SecurityGroup(this, "InternalSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    [Port.tcp(this.APP_PORT), Port.tcp(9901), Port.tcp(15000)].forEach(port => {
      this.internalSecurityGroup.connections.allowInternally(port);
    });
  }

  createCluster() {
    // Deploy a Fargate cluster on ECS
    this.cluster = new Cluster(this, "Cluster", {
      vpc: this.vpc,
    });

    // Use Cloud Map for service discovery within the cluster, which
    // relies on either ECS Service Discovery or App Mesh integration
    // (default: cloudmap.NamespaceType.DNS_PRIVATE)
    let ns = this.cluster.addDefaultCloudMapNamespace({
      name: this.namespace,
    });
    // we need to ensure the service record is created for after we enable app mesh
    // (there is no resource we create here that will make this happen implicitly
    // since CDK won't all two services to register the same service name in
    // Cloud Map, even though we can discriminate between them using service attributes
    // based on ECS_TASK_DEFINITION_FAMILY
    // let serviceName = new Service(this, "colorteller", {
    //   name: 'colorteller',
    //   namespace: ns,
    //   dnsTtl: this.DEF_TTL,
    // });

    // grant cloudwatch and xray permissions to IAM task role for color app tasks
    this.taskRole = new Role(this, "TaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess"),
      ],
    });

    // grant ECR pull permission to IAM task execution role for ECS agent
    this.taskExecutionRole = new Role(this, "TaskExecutionRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ContainerRegistryReadOnly"),
      ],
    });
  }

  createGateway() {
    let gatewayTaskDef = new FargateTaskDefinition(this, "GatewayTaskDef", {
      family: "gateway",
      taskRole: this.taskRole,
      executionRole: this.taskExecutionRole,
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    let gatewayContainer = gatewayTaskDef.addContainer("app", {
      image: ContainerImage.fromRegistry(this.GatewayImage),
      environment: {
        SERVER_PORT: `${this.APP_PORT}`,
        COLOR_TELLER_ENDPOINT: `colorteller.${this.namespace}:${this.APP_PORT}`,
      },
      logging: LogDriver.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: "gateway",
      }),
    });
    gatewayContainer.addPortMappings({
      containerPort: this.APP_PORT,
    });

    let gatewayService = new FargateService(this, "GatewayService", {
      cluster: this.cluster,
      serviceName: "gateway",
      taskDefinition: gatewayTaskDef,
      desiredCount: 1,
      securityGroup: this.internalSecurityGroup,
      cloudMapOptions: {
        name: "gateway",
      },
    });

    let alb = new ApplicationLoadBalancer(this, "PublicALB", {
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.externalSecurityGroup,
    });
    let albListener = alb.addListener("web", {
      port: 80,
    });
    albListener.addTargets("Target", {
      port: 80,
      targets: [gatewayService],
      healthCheck: {
        path: "/ping",
        port: "traffic-port",
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        "healthyHttpCodes": "200-499",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });
    // CDK will print after finished deploying stack
    new CfnOutput(this, "URL", {
      description: "Color App public URL",
      value: alb.loadBalancerDnsName,
    });
  }

  createColorTeller(...colors: string[]) {
    let create = (color: string, serviceName: string) => {
      let taskDef = new FargateTaskDefinition(this, `${color}_taskdef-v2`, {
        family: color,
        taskRole: this.taskRole,
        executionRole: this.taskExecutionRole,
        cpu: 512,
        memoryLimitMiB: 1024,
      });

      let container = taskDef.addContainer("app", {
        image: ContainerImage.fromRegistry(this.ColorTellerImage),
        environment: {
          SERVER_PORT: `${this.APP_PORT}`,
          COLOR: color,
        },
        logging: LogDriver.awsLogs({
          logGroup: this.logGroup,
          streamPrefix: `colorteller-${color}`,
        }),
      });
      container.addPortMappings({
        containerPort: this.APP_PORT,
      });

      let service = new FargateService(this, `ColorTellerService-${color}`, {
        cluster: this.cluster,
        serviceName: serviceName,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroup: this.internalSecurityGroup,
        cloudMapOptions: {
          name: serviceName,
          dnsTtl: this.DEF_TTL,
        },
      });
    };

    // initial color is a special case; before we enable app mesh, gateway
    // needs to reference an actual colorteller.mesh.local service (COLOR_TELLER_ENDPOINT);
    // the other colors need a unique namespace for now because CDK won't
    // allow reusing the same service name (although we can do this without
    // CDK; this is supported by Cloud Map / App Mesh, which uses Cloud
    // Map attributes for ECS service discovery: ECS_TASK_DEFINITION_FAMILY
    create(colors[0], "colorteller");
    colors.slice(1).forEach(color => {
      create(color, `colorteller-${color}`);
    });
  }

  createMesh() {
    this.mesh = new CfnMesh(this, "Mesh", {
      // use the same name to make it easy to identify the stack it's associated with
      meshName: this.stackName,
    });

    this.createVirtualNodes();
    let router = this.createVirtualRouter();
    this.createRoute(router);
    this.createVirtualService(router);
  }

  createVirtualNodes() {
    let create = (name: string, serviceName?: string) => {
      serviceName = serviceName || name;

      // WARNING: keep name in sync with the route spec, if using this node in a route
      // WARNING: keep name in sync with the virtual service, if using this node as a provider
      // update the route spec as well in createRoute()
      let nodeName = `${name}-vn`;
      (new CfnVirtualNode(this, nodeName, {
        meshName: this.mesh.meshName,
        virtualNodeName: nodeName,
        spec: {
          serviceDiscovery: {
            dns: {
              hostname: serviceName,
            },
          },
          listeners: [{
            portMapping: {
              protocol: "http",
              port: this.APP_PORT,
            },
            healthCheck: {
              healthyThreshold: 2,
              intervalMillis: 10 * 1000,
              path: "/ping",
              port: this.APP_PORT,
              protocol: "http",
              timeoutMillis: 5 * 1000,
              unhealthyThreshold: 2,
            },
          }],
          backends: [{
            virtualService: {
              virtualServiceName: `colorteller.${this.namespace}`,
            }
          }],
        },
      })).addDependsOn(this.mesh);
    };

    // creates: gateway-vn => gateway.mesh.local
    create("gateway");

    // for the first color, creates: {color}-vn => colorteller.mesh.local
    // special case: first color is the default color used for colorteller.mesh.local
    create(this.colors[0], "colorteller");

    // for all the colors except the first one, creates: {color}-vn => colorteller-{color}.mesh.local
    this.colors.slice(1).forEach(color => {
      create(color, `colorteller-${color}`);
    });
  }

  createVirtualRouter(): CfnVirtualRouter {
    let router = new CfnVirtualRouter(this, "ColorTellerVirtualRouter", {
      // WARNING: keep in sync with virtual service provider if using this
      virtualRouterName: "colorteller-vr",
      meshName: this.mesh.meshName,
      spec: {
        listeners: [{
          portMapping: {
            protocol: "http",
            port: this.APP_PORT,
          },
        }],
      },
    });
    router.addDependsOn(this.mesh);
    return router;
  }

  createRoute(router: CfnVirtualRouter) {
    let route = new CfnRoute(this, "ColorRoute", {
      routeName: "color-route",
      meshName: this.mesh.meshName,
      virtualRouterName: router.virtualRouterName,
      spec: {
        httpRoute: {
          match: {
            prefix: "/",
          },
          action: {
            weightedTargets: [{
              // WARNING: if you change the name for a virtual node, make sure you update this also
              virtualNode: "blue-vn",
              weight: 1,
            },{
              virtualNode: "green-vn",
              weight: 1,
            }],
          },
        },
      },
    });
    route.addDependsOn(router);
  }

  createVirtualService(router: CfnVirtualRouter) {
    let svc = new CfnVirtualService(this, "ColorTellerVirtualService", {
      virtualServiceName: `colorteller.${this.namespace}`,
      meshName: this.mesh.meshName,
      spec: {
        provider: {
          // WARNING: keep in sync with virtual node name if using that as this provider
          // WARNING: keep in sync with virtual router name if using that as this provider
          virtualRouter: {virtualRouterName: "colorteller-vr"},
        },
      },
    });
    svc.addDependsOn(router);
  }

}

